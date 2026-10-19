import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Component } from './catalog.ts'
import {
  GENERAL_TYPE,
  VACANT_TYPE,
  sameSoftware,
  typeSupportsOs,
  type GroupRecord,
  type ServerTypeView,
  type TypeOptions,
} from './definitions.ts'
import { errorPayload, ServerError, type ErrorCode } from './i18n.ts'
import { keyInUse, retestAfterEdit, type RetestSnap } from './jobs.ts'
import {
  parseDeclaredOs,
  sameDeclaredOs,
  osVerification,
  type DeclaredOs,
  type DetectedOs,
} from './operating-systems.ts'
import { chosenRegion, lookupRegion } from './region.ts'
import { DefinitionRegistry, type TypeLease } from './registry.ts'
import { field, readJson, sendJson, text } from './reply.ts'
import { componentView, enqueueOn as enqueue, HttpError, type Db, type JobRecord } from './store.ts'
import { keyFingerprint, SshError } from './ssh.ts'
import type { Enrollment } from './enrollment.ts'

interface Secrets {
  encrypt(secret: string): string
  decrypt(ciphertext: string): string
}

export interface Deps {
  db: Db
  secrets: Secrets
  catalog: readonly Component[]
  definitions: DefinitionRegistry
  enrollment: Enrollment
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function routeServers(
  deps: Deps,
  request: IncomingMessage,
  response: ServerResponse,
  rest: string,
): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listServers(deps))
  if (rest === '' && request.method === 'POST')
    return sendJson(response, 201, await createServer(deps, await readJson(request)))
  if (rest === '/test-connection' && request.method === 'POST')
    return sendJson(response, 200, await deps.enrollment.test(await readJson(request)))
  if (rest === '/identify-system' && request.method === 'POST')
    return sendJson(response, 200, await deps.enrollment.identify(await readJson(request)))
  const parts = rest.split('/').filter(Boolean)
  const id = parts[0] ?? ''
  if (!UUID.test(id)) throw new HttpError(404, 'server_not_found')
  if (parts.length === 1 && request.method === 'GET') return sendJson(response, 200, await serverDetail(deps, id))
  if (parts.length === 1 && request.method === 'PATCH')
    return sendJson(response, 200, await updateServer(deps, id, await readJson(request)))
  if (parts.length === 1 && request.method === 'DELETE') {
    await deleteServer(deps.db, id)
    response.writeHead(204)
    response.end()
    return
  }
  if (parts.length === 2 && parts[1] === 'containers' && request.method === 'GET')
    return sendJson(response, 200, await containersOf(deps.db, id))
  const action =
    parts.length === 2
      ? (
          { test: 'test_connection', inspect: 'inspect', 'install-components': 'install_components' } as Record<
            string,
            string
          >
        )[parts[1]!]
      : undefined
  if (action !== undefined && request.method === 'POST')
    return sendJson(response, 202, jobView(await enqueueExisting(deps, id, action)))
  throw new HttpError(404, 'server_not_found')
}

export async function routeGroups(
  db: Db,
  request: IncomingMessage,
  response: ServerResponse,
  rest: string,
  definitions: DefinitionRegistry,
): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listGroups(db, definitions))
  if (rest === '' && request.method === 'POST')
    return sendJson(response, 201, await createGroup(db, definitions, await readJson(request)))
  const id = rest.slice(1)
  if (request.method === 'DELETE' && UUID.test(id)) {
    await deleteGroup(db, id)
    response.writeHead(204)
    response.end()
    return
  }
  throw new HttpError(404, 'group_not_found')
}

export async function routeTypes(
  definitions: DefinitionRegistry,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed')
  const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('group_id')
  if (id && !UUID.test(id)) throw new HttpError(404, 'group_not_found')
  sendJson(response, 200, await definitions.options(id || null))
}

export async function routeKeys(
  deps: Deps,
  request: IncomingMessage,
  response: ServerResponse,
  rest: string,
): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listKeys(deps.db))
  if (rest === '' && request.method === 'POST')
    return sendJson(response, 201, await createKey(deps, await readJson(request)))
  const id = rest.slice(1)
  if (request.method === 'DELETE' && UUID.test(id)) {
    await deleteKey(deps.db, id)
    response.writeHead(204)
    response.end()
    return
  }
  throw new HttpError(404, 'key_not_found')
}

export async function routeJobs(
  db: Db,
  request: IncomingMessage,
  response: ServerResponse,
  rest: string,
): Promise<void> {
  const id = rest.slice(1)
  if (request.method === 'GET' && UUID.test(id)) {
    const result = await db.query<JobRecord>('select * from server_jobs where id = $1', [id])
    if (result.rows[0] !== undefined) return sendJson(response, 200, jobView(result.rows[0]))
  }
  throw new HttpError(404, 'job_not_found')
}

export function routeComponents(
  catalog: readonly Component[],
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed')
  sendJson(response, 200, componentView(catalog))
}

async function listServers(deps: Deps): Promise<Record<string, unknown>[]> {
  const result = await deps.db
    .query(`select s.id,s.name,s.host,s.ssh_port,s.ssh_user,s.auth_method,s.ssh_key_id,s.group_id,
    g.name as group_name,g.name_i18n as group_name_i18n,g.kind as group_kind,s.region,s.install_required_software,s.type_key,s.type_snapshot,s.type_revision,s.config_revision,
    s.declared_os,s.host_fingerprint,s.created_at,r.connection_state as reachability,r.connection_checked_at as last_checked_at,
    r.detected_os,r.os_probe_state,r.observed_config_revision,r.environment_revision,r.os_checked_at,r.os_error,
    r.cpu_cores,r.cpu_percent,r.memory_total_bytes as mem_total_bytes,r.memory_used_bytes as mem_used_bytes,r.disk_total_bytes,r.disk_used_bytes,r.metrics_sampled_at as metrics_at,
    coalesce(c.state,'unknown') as containers_state,c.last_success_at as containers_checked_at,
    case when c.state='ready' then (select count(*)::int from server_containers where server_id=s.id) else null end as container_count
    from servers s join server_runtime r on r.server_id=s.id left join server_groups g on g.id=s.group_id left join server_container_scans c on c.server_id=s.id order by s.name,s.id`)
  const observations = await deps.db.query('select * from server_software_observations')
  const byServer = new Map<string, Map<string, Record<string, unknown>>>()
  for (const item of observations.rows) {
    const id = String(item.server_id)
    if (!byServer.has(id)) byServer.set(id, new Map())
    byServer.get(id)!.set(String(item.software_key), item)
  }
  const options = new Map<string | null, TypeOptions>()
  await Promise.all(
    [...new Set(result.rows.map((row) => row.group_id as string | null))].map(async (id) => {
      try {
        options.set(id, await deps.definitions.options(id))
      } catch (cause) {
        if (!(cause instanceof ServerError) || cause.code !== 'group_not_found') throw cause
        options.set(id, { kind: 'user', available: false, default_type_key: '', types: [] })
      }
    }),
  )
  const resolvedTypes = new Map<string, ServerTypeView>()
  const bindingKey = (row: Record<string, unknown>) => JSON.stringify([row.group_id, row.type_key, row.declared_os])
  const bindings = new Map(result.rows.map(row => [bindingKey(row), row]))
  await Promise.all([...bindings].map(async ([key,row]) => {
    let lease: TypeLease | undefined
    try {
      lease = await deps.definitions.lease(row.group_id as string | null, String(row.type_key), row.declared_os as DeclaredOs)
      if (lease) resolvedTypes.set(key, lease.type)
    } catch (cause) {
      if (!(cause instanceof ServerError)) throw cause
    } finally { lease?.release() }
  }))
  return result.rows.map((row) => {
    const visible = omitSecrets(row)
    const choice = options.get(row.group_id as string | null)!
    const current = resolvedTypes.get(bindingKey(row))
    const cached = row.type_snapshot as ServerTypeView | null
    const fallback = deps.definitions.defaultOptions().types.find((type) => type.key === row.type_key)
    const type = current ?? cached ?? fallback
    const available = choice.available && current !== undefined
    const required = type?.software ?? []
    const observed = byServer.get(String(row.id))
    const status: Record<
      string,
      {
        state: string
        installed: boolean
        version?: unknown
        last_known_version?: unknown
        detail?: string
        revision?: unknown
      }
    > = {}
    for (const item of required) {
      const fact = observed?.get(item.software_key)
      const fresh =
        fact &&
        fact.recipe_revision === item.revision &&
        String(fact.observed_config_revision) === String(row.config_revision) &&
        String(fact.observed_environment_revision) === String(row.environment_revision)
      const state = fresh ? String(fact.probe_state) : 'unknown'
      status[item.id] = {
        state,
        installed: state === 'installed',
        version: state === 'installed' ? fact?.product_version : undefined,
        last_known_version: fact?.product_version,
        detail: (fact?.error as { detail?: string } | null)?.detail,
        revision: fact?.recipe_revision,
      }
    }
    const osState =
      String(row.observed_config_revision) === String(row.config_revision) ? String(row.os_probe_state) : 'unknown'
    const verification = osVerification(row.declared_os as DeclaredOs, row.detected_os as DetectedOs | null, osState)
    const states = required.map(
      (item) => status[item.id]?.state ?? (status[item.id]?.installed === true ? 'installed' : 'unknown'),
    )
    const softwareState = !available
      ? 'unavailable'
      : required.length === 0 || states.every((state) => state === 'installed')
        ? 'ready'
        : states.some((state) => state === 'missing')
          ? 'pending'
          : 'unknown'
    return {
      ...visible,
      software_status: status,
      os_verification: verification,
      type_supported_os: type?.supportedOs,
      type_os_compatible: type !== undefined && typeSupportsOs(type, row.declared_os as DeclaredOs),
      docker_version: observed?.get('builtin/docker-engine')?.product_version ?? null,
      compose_version: observed?.get('builtin/docker-compose')?.product_version ?? null,
      type_name_i18n: type?.name_i18n ?? { zh: String(row.type_key), en: String(row.type_key) },
      type_available: available,
      required_software: required,
      software_state: softwareState,
    }
  })
}

async function serverDetail(deps: Deps, id: string): Promise<unknown> {
  const server = (await listServers(deps)).find((item) => item.id === id)
  if (server === undefined) throw new HttpError(404, 'server_not_found')
  const containers = await deps.db.query(
    'select container_id, name, image, status, ports, managed, strategy_slug, observed_at from server_containers where server_id = $1 order by name',
    [id],
  )
  const jobs = await deps.db.query('select * from server_jobs where server_id = $1 order by created_at desc limit 20', [
    id,
  ])
  return { ...server, containers: containers.rows, jobs: jobs.rows.map(jobView) }
}

async function selectType(
  definitions: DefinitionRegistry,
  groupId: string | null,
  os: DeclaredOs,
  key?: string,
): Promise<TypeLease> {
  const options = await definitions.options(groupId, os)
  if (!options.available) throw new HttpError(409, 'type_unavailable')
  const selected = key ?? options.default_type_key
  if (!options.types.some((type) => type.key === selected)) throw new HttpError(422, 'type_not_found')
  const lease = await definitions.lease(groupId, selected, os)
  if (lease === undefined) throw new HttpError(409, 'type_unavailable')
  if (!typeSupportsOs(lease.type, os)) {
    lease.release()
    throw new HttpError(422, 'os_type_unsupported')
  }
  return lease
}

function readonlySoftware(body: unknown): void {
  if (field(body, 'install_component_ids') !== undefined) throw new HttpError(422, 'required_software_readonly')
}

async function createServer(deps: Deps, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'name_required')
  const host = required(text(field(body, 'host')), 'host_required')
  const port = portOf(field(body, 'ssh_port'))
  const user = required(text(field(body, 'ssh_user')), 'user_required')
  readonlySoftware(body)
  const method = text(field(body, 'auth_method'))
  if (method !== 'private_key' && method !== 'password') throw new HttpError(422, 'auth_required')
  const os = parseDeclaredOs(field(body, 'declared_os'))
  const groupId = await groupOrNull(deps.db, field(body, 'group_id'))
  const region = await regionOf(host, field(body, 'region'))
  let keyId: string | null = null
  let secret = ''
  if (method === 'private_key') {
    keyId = text(field(body, 'ssh_key_id'))
    if (!UUID.test(keyId)) throw new HttpError(422, 'key_required')
    if ((await deps.db.query('select id from ssh_keys where id = $1', [keyId])).rows.length === 0)
      throw new HttpError(422, 'key_not_found')
  } else {
    secret = required(text(field(body, 'secret')), 'password_required')
  }
  const lease = await selectType(
    deps.definitions,
    groupId,
    os,
    field(body, 'type_key') === undefined ? undefined : text(field(body, 'type_key')),
  )
  const id = randomUUID()
  try {
    const client = await deps.db.connect()
    try {
      await client.query('begin')
      await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
      await groupOrNull(client, groupId)
      const auto = field(body, 'install_required_software') === true && lease.components.length > 0
      await client.query(
        `insert into servers (id, name, host, ssh_port, ssh_user, auth_method, secret_ciphertext, ssh_key_id, group_id, region,
          install_required_software, declared_os, type_key, type_snapshot, type_revision)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          name,
          host,
          port,
          user,
          method,
          method === 'password' ? deps.secrets.encrypt(secret) : null,
          keyId,
          groupId,
          region,
          auto,
          JSON.stringify(os),
          lease.type.key,
          JSON.stringify(lease.type),
          lease.signature,
        ],
      )
      await client.query('insert into server_runtime(server_id) values ($1)', [id])
      if (auto || field(body, 'inspect_after_save') === true)
        await enqueue(client, id, 'test_connection', { configRevision: 1, typeSignature: lease.signature }, auto)
      await client.query('commit')
    } catch (cause) {
      await client.query('rollback')
      if (isUnique(cause)) throw new HttpError(409, 'server_exists')
      throw cause
    } finally {
      client.release()
    }
  } finally {
    lease.release()
  }
  return serverDetail(deps, id)
}

interface EditableServer {
  id: string
  host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  install_required_software: boolean
  declared_os: DeclaredOs
  group_id: string | null
  type_key: string
  type_snapshot: ServerTypeView | null
  type_revision: string
  config_revision: string | number
}

async function updateServer(deps: Deps, id: string, body: unknown): Promise<unknown> {
  readonlySoftware(body)
  const client = await deps.db.connect()
  let lease: TypeLease | undefined
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
    const row = (
      await client.query<EditableServer>(
        'select id, host, ssh_port, ssh_user, auth_method, ssh_key_id, install_required_software, declared_os, group_id, type_key, type_snapshot, type_revision, config_revision from servers where id = $1 for update',
        [id],
      )
    ).rows[0]
    if (row === undefined) throw new HttpError(404, 'server_not_found')
    const sets: string[] = []
    const params: unknown[] = [id]
    const assign = (column: string, value: unknown) => {
      params.push(value)
      sets.push(`${column} = $${params.length}`)
    }
    const before: RetestSnap = {
      autoInstall: row.install_required_software,
      host: row.host,
      port: row.ssh_port,
      user: row.ssh_user,
      method: row.auth_method,
      keyId: row.ssh_key_id,
      selection: JSON.stringify(row.type_snapshot?.software.map((item) => item.id) ?? []),
      secretWritten: false,
    }
    const after = { ...before }
    const groupId =
      field(body, 'group_id') === undefined ? row.group_id : await groupOrNull(client, field(body, 'group_id'))
    const choices = await deps.definitions.options(groupId)
    const key =
      field(body, 'type_key') !== undefined
        ? text(field(body, 'type_key'))
        : groupId === row.group_id || choices.types.some((type) => type.key === row.type_key)
          ? row.type_key
          : choices.default_type_key
    const bindingChanged = groupId !== row.group_id || key !== row.type_key
    const os =
      field(body, 'declared_os') === undefined
        ? row.declared_os
        : parseDeclaredOs(field(body, 'declared_os'), row.declared_os)
    const osChanged = !sameDeclaredOs(os, row.declared_os)
    if (bindingChanged) {
      const runtime = (
        await client.query<{
          detected_os: DetectedOs | null
          os_probe_state: string
          observed_config_revision: string
        }>('select detected_os,os_probe_state,observed_config_revision from server_runtime where server_id=$1', [id])
      ).rows[0]!
      if (
        osVerification(
          os,
          runtime.detected_os,
          String(runtime.observed_config_revision) === String(row.config_revision) ? runtime.os_probe_state : 'unknown',
        ) === 'mismatch'
      )
        throw new HttpError(409, 'os_mismatch')
    }
    lease =
      bindingChanged || osChanged
        ? await selectType(deps.definitions, groupId, os, key)
        : await deps.definitions.lease(groupId, key, os)
    const prior = row.type_snapshot ?? deps.definitions.defaultOptions().types.find((type) => type.key === row.type_key)
    if (
      bindingChanged &&
      lease !== undefined &&
      lease.components.length > 0 &&
      (prior === undefined || !sameSoftware(prior, lease.type))
    )
      throw new HttpError(409, 'type_change_requires_preflight')
    if (field(body, 'name') !== undefined) assign('name', required(text(field(body, 'name')), 'name_required'))
    if (field(body, 'host') !== undefined) {
      after.host = required(text(field(body, 'host')), 'host_required')
      assign('host', after.host)
    }
    if (field(body, 'ssh_port') !== undefined) {
      after.port = portOf(field(body, 'ssh_port'))
      assign('ssh_port', after.port)
    }
    if (field(body, 'ssh_user') !== undefined) {
      after.user = required(text(field(body, 'ssh_user')), 'user_required')
      assign('ssh_user', after.user)
    }
    if (field(body, 'region') !== undefined) assign('region', await regionOf(after.host, field(body, 'region')))
    after.autoInstall =
      field(body, 'install_required_software') === undefined
        ? row.install_required_software
        : field(body, 'install_required_software') === true
    if (lease !== undefined) {
      if (lease.components.length === 0) after.autoInstall = false
      after.selection = JSON.stringify(lease.components.map((item) => item.id))
      if (after.autoInstall && prior !== undefined && !sameSoftware(prior, lease.type))
        throw new HttpError(409, 'type_change_requires_preflight')
      assign('type_key', key)
      assign('type_snapshot', JSON.stringify(lease.type))
      assign('type_revision', lease.signature)
    } else if (after.autoInstall && !row.install_required_software) throw new HttpError(409, 'type_unavailable')
    assign('install_required_software', after.autoInstall)
    if (osChanged) assign('declared_os', JSON.stringify(os))
    if (bindingChanged) assign('group_id', groupId)
    if (
      field(body, 'auth_method') !== undefined ||
      field(body, 'ssh_key_id') !== undefined ||
      field(body, 'secret') !== undefined
    ) {
      const method = field(body, 'auth_method') === undefined ? row.auth_method : text(field(body, 'auth_method'))
      if (method === 'private_key') {
        const keyId = field(body, 'ssh_key_id') === undefined ? (row.ssh_key_id ?? '') : text(field(body, 'ssh_key_id'))
        if (!UUID.test(keyId)) throw new HttpError(422, 'key_required')
        if ((await client.query('select id from ssh_keys where id = $1', [keyId])).rows.length === 0)
          throw new HttpError(422, 'key_not_found')
        after.method = 'private_key'
        after.keyId = keyId
        assign('auth_method', 'private_key')
        assign('ssh_key_id', keyId)
        assign('secret_ciphertext', null)
      } else if (method === 'password') {
        const secret = text(field(body, 'secret'))
        if (secret === '' && row.auth_method !== 'password') throw new HttpError(422, 'password_required')
        after.method = 'password'
        after.keyId = null
        after.secretWritten = secret !== ''
        assign('auth_method', 'password')
        assign('ssh_key_id', null)
        if (secret !== '') assign('secret_ciphertext', deps.secrets.encrypt(secret))
      } else throw new HttpError(422, 'auth_required')
    }
    const definitionChanged = lease !== undefined && lease.signature !== row.type_revision
    const critical =
      osChanged ||
      bindingChanged ||
      definitionChanged ||
      before.host !== after.host ||
      before.port !== after.port ||
      before.user !== after.user ||
      before.method !== after.method ||
      before.keyId !== after.keyId ||
      before.autoInstall !== after.autoInstall ||
      before.selection !== after.selection ||
      after.secretWritten
    if (critical) await notRunning(client, id)
    const revision = critical ? String(BigInt(row.config_revision) + 1n) : row.config_revision
    if (critical) assign('config_revision', revision)
    await client.query(`update servers set ${sets.join(', ')}, updated_at = now() where id = $1`, params)
    if (critical)
      await client.query(
        "update server_runtime set connection_state='unknown', connection_error=null, connection_checked_at=null where server_id=$1",
        [id],
      )
    if (osChanged || retestAfterEdit(before, after) || field(body, 'inspect_after_save') === true)
      await enqueue(
        client,
        id,
        'test_connection',
        { configRevision: revision, typeSignature: lease?.signature ?? '' },
        after.autoInstall,
      )
    await client.query('commit')
  } catch (cause) {
    await client.query('rollback')
    if (isUnique(cause)) throw new HttpError(409, 'server_exists')
    throw cause
  } finally {
    client.release()
    lease?.release()
  }
  return serverDetail(deps, id)
}

async function notRunning(db: Db, id: string): Promise<void> {
  if (
    (
      await db.query(
        "select id from server_jobs where server_id = $1 and state in ('claimed','running','recovering') limit 1",
        [id],
      )
    ).rows.length > 0
  )
    throw new HttpError(409, 'server_busy')
}

async function enqueueExisting(deps: Deps, id: string, action: string): Promise<JobRecord> {
  const client = await deps.db.connect()
  let lease: TypeLease | undefined
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
    const row = (
      await client.query<EditableServer>(
        'select id, group_id, type_key, config_revision, declared_os from servers where id = $1 for update',
        [id],
      )
    ).rows[0]
    if (row === undefined) throw new HttpError(404, 'server_not_found')
    lease = await deps.definitions.lease(row.group_id, row.type_key, row.declared_os)
    if (action === 'install_components' && lease === undefined) throw new HttpError(409, 'type_unavailable')
    if (action === 'install_components' && lease?.components.length === 0)
      throw new HttpError(422, 'no_required_software')
    const job = await enqueue(client, id, action, {
      configRevision: row.config_revision,
      typeSignature: lease?.signature ?? '',
    })
    await client.query('commit')
    return job
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
    lease?.release()
  }
}

async function deleteServer(db: Db, id: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('begin')
    if ((await client.query('select id from servers where id=$1 for update', [id])).rows.length === 0)
      throw new HttpError(404, 'server_not_found')
    await notRunning(client, id)
    await client.query(
      "update server_jobs set state='cancelled',finished_at=now() where server_id=$1 and state='queued'",
      [id],
    )
    await client.query(
      "update server_change_plans p set state='cancelled' from server_change_targets t where p.id=t.plan_id and t.server_id=$1 and t.state='pending'",
      [id],
    )
    await client.query(
      "update server_change_targets set state='cancelled',finished_at=now() where server_id=$1 and state='pending'",
      [id],
    )
    await client.query('delete from servers where id=$1', [id])
    await client.query('commit')
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}

async function listGroups(db: Db, definitions: DefinitionRegistry): Promise<unknown[]> {
  const result = await db.query<GroupRecord>(
    `select g.*, (select count(*)::int from servers s where s.group_id = g.id) as server_count from server_groups g order by sort_order, created_at, id`,
  )
  return result.rows.map((row) => definitions.view(row))
}

async function createGroup(db: Db, definitions: DefinitionRegistry, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'group_name_required')
  if (['未分组', '全部服务器', 'ungrouped', 'all servers'].includes(name.toLowerCase()))
    throw new HttpError(422, 'group_name_reserved')
  if (
    ['kind', 'plugin_id', 'group_key', 'types', 'definition', 'name_i18n'].some((key) => field(body, key) !== undefined)
  )
    throw new HttpError(422, 'group_source_readonly')
  try {
    const result = await db.query<GroupRecord>('insert into server_groups (id, name) values ($1, $2) returning *', [
      randomUUID(),
      name,
    ])
    return definitions.view({ ...result.rows[0]!, server_count: 0 })
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, 'group_exists')
    throw cause
  }
}

async function deleteGroup(db: Db, id: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
    const row = (await client.query<{ kind: string }>('select kind from server_groups where id = $1 for update', [id]))
      .rows[0]
    if (row === undefined) throw new HttpError(404, 'group_not_found')
    if (row.kind === 'system') throw new HttpError(403, 'system_group_protected')
    const servers = await client.query<{
      id: string
      type_key: string
      declared_os: DeclaredOs
      detected_os: DetectedOs | null
      os_probe_state: string
      config_revision: string
      observed_config_revision: string
    }>(
      'select s.id,s.type_key,s.declared_os,s.config_revision,r.detected_os,r.os_probe_state,r.observed_config_revision from servers s join server_runtime r on r.server_id=s.id where s.group_id=$1 for update of s',
      [id],
    )
    for (const server of servers.rows) {
      if (server.type_key !== VACANT_TYPE && server.type_key !== GENERAL_TYPE)
        throw new HttpError(409, 'type_change_requires_preflight')
      await notRunning(client, server.id)
      if (
        String(server.config_revision) === String(server.observed_config_revision) &&
        osVerification(server.declared_os, server.detected_os, server.os_probe_state) === 'mismatch'
      )
        throw new HttpError(409, 'os_mismatch')
    }
    await client.query(
      'update servers set group_id = null, config_revision = config_revision + 1, updated_at = now() where group_id = $1',
      [id],
    )
    await client.query('delete from server_groups where id = $1', [id])
    await client.query('commit')
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}

async function listKeys(db: Db): Promise<unknown[]> {
  return (
    await db.query(
      `select k.id, k.name, k.fingerprint, k.created_at, (select count(*)::int from servers s where s.ssh_key_id = k.id) as server_count from ssh_keys k order by k.name`,
    )
  ).rows
}

async function createKey(deps: Deps, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'name_required')
  const secret = required(text(field(body, 'secret')), 'private_key_required')
  let fingerprint: string
  try {
    fingerprint = keyFingerprint(secret)
  } catch (cause) {
    throw new HttpError(
      422,
      cause instanceof SshError ? cause.code : 'key_invalid',
      cause instanceof SshError ? cause.params : {},
      { cause },
    )
  }
  try {
    const result = await deps.db.query(
      'insert into ssh_keys (id, name, fingerprint, secret_ciphertext) values ($1, $2, $3, $4) returning id, name, fingerprint, created_at',
      [randomUUID(), name, fingerprint, deps.secrets.encrypt(secret)],
    )
    return { ...result.rows[0], server_count: 0 }
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, 'key_exists')
    throw cause
  }
}

async function deleteKey(db: Db, id: string): Promise<void> {
  const count = Number(
    (await db.query<{ count: number }>('select count(*)::int as count from servers where ssh_key_id = $1', [id]))
      .rows[0]?.count ?? 0,
  )
  if (keyInUse(count)) throw new HttpError(409, 'key_in_use')
  if ((await db.query('delete from ssh_keys where id = $1 returning id', [id])).rows.length === 0)
    throw new HttpError(404, 'key_not_found')
}

function jobView(row: JobRecord | Record<string, unknown>) {
  return {
    id: row.id,
    action: (row.request_snapshot as { action?: string })?.action ?? row.purpose,
    status: row.state,
    phase: row.phase,
    result: row.result,
    output_excerpt: row.output_excerpt,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }
}

const HIDDEN = ['secret_ciphertext', 'secret', 'password', 'private_key']

export function omitSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const visible = { ...row }
  for (const key of HIDDEN) delete visible[key]
  return visible
}

async function containersOf(db: Db, id: string): Promise<unknown[]> {
  if ((await db.query('select id from servers where id = $1', [id])).rows.length === 0)
    throw new HttpError(404, 'server_not_found')
  return (
    await db.query(
      'select container_id, name, image, status, ports, managed, strategy_slug, observed_at from server_containers where server_id = $1 order by name',
      [id],
    )
  ).rows
}

async function groupOrNull(db: Db, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null
  const id = text(value)
  if (!UUID.test(id)) throw new HttpError(422, 'group_not_found')
  if ((await db.query('select id from server_groups where id = $1', [id])).rows.length === 0)
    throw new HttpError(422, 'group_not_found')
  return id
}

async function regionOf(host: string, value: unknown): Promise<string> {
  const written = typeof value === 'string' ? value : ''
  return (written.trim() === '' ? await lookupRegion(host) : chosenRegion(host, written, null)) ?? ''
}

function portOf(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(422, 'port_invalid')
  return port
}

function required(value: string, code: ErrorCode): string {
  if (value === '') throw new HttpError(422, code)
  return value
}

function isUnique(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505'
}
