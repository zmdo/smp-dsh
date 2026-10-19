import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Component } from './catalog.ts'
import { GENERAL_TYPE, VACANT_TYPE, sameSoftware, type GroupRecord, type ServerTypeView, type TypeOptions } from './definitions.ts'
import { errorPayload, ServerError, type ErrorCode } from './i18n.ts'
import { keyInUse, retestAfterEdit, type RetestSnap } from './jobs.ts'
import { chosenRegion, lookupRegion } from './region.ts'
import { DefinitionRegistry, type TypeLease } from './registry.ts'
import { field, readJson, sendJson, text } from './reply.ts'
import { componentView, enqueue, HttpError, type Db, type JobRecord } from './store.ts'
import { keyFingerprint, SshError, connectSsh } from './ssh.ts'

interface Secrets {
  encrypt(secret: string): string
  decrypt(ciphertext: string): string
}

export interface Deps {
  db: Db
  secrets: Secrets
  catalog: readonly Component[]
  definitions: DefinitionRegistry
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function routeServers(deps: Deps, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listServers(deps))
  if (rest === '' && request.method === 'POST') return sendJson(response, 201, await createServer(deps, await readJson(request)))
  if (rest === '/test-connection' && request.method === 'POST') return sendJson(response, 200, await preview(await readJson(request)))
  const parts = rest.split('/').filter(Boolean)
  const id = parts[0] ?? ''
  if (!UUID.test(id)) throw new HttpError(404, 'server_not_found')
  if (parts.length === 1 && request.method === 'GET') return sendJson(response, 200, await serverDetail(deps, id))
  if (parts.length === 1 && request.method === 'PATCH') return sendJson(response, 200, await updateServer(deps, id, await readJson(request)))
  if (parts.length === 1 && request.method === 'DELETE') {
    await deleteServer(deps.db, id)
    response.writeHead(204); response.end(); return
  }
  if (parts.length === 2 && parts[1] === 'containers' && request.method === 'GET') return sendJson(response, 200, await containersOf(deps.db, id))
  const action = parts.length === 2 ? ({ test: 'test_connection', inspect: 'inspect', 'install-components': 'install_components' } as Record<string, string>)[parts[1]!] : undefined
  if (action !== undefined && request.method === 'POST') return sendJson(response, 202, jobView(await enqueueExisting(deps, id, action)))
  throw new HttpError(404, 'server_not_found')
}

export async function routeGroups(db: Db, request: IncomingMessage, response: ServerResponse, rest: string, definitions: DefinitionRegistry): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listGroups(db, definitions))
  if (rest === '' && request.method === 'POST') return sendJson(response, 201, await createGroup(db, definitions, await readJson(request)))
  const id = rest.slice(1)
  if (request.method === 'DELETE' && UUID.test(id)) {
    await deleteGroup(db, id)
    response.writeHead(204); response.end(); return
  }
  throw new HttpError(404, 'group_not_found')
}

export async function routeTypes(definitions: DefinitionRegistry, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed')
  const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('group_id')
  if (id && !UUID.test(id)) throw new HttpError(404, 'group_not_found')
  sendJson(response, 200, await definitions.options(id || null))
}

export async function routeKeys(deps: Deps, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listKeys(deps.db))
  if (rest === '' && request.method === 'POST') return sendJson(response, 201, await createKey(deps, await readJson(request)))
  const id = rest.slice(1)
  if (request.method === 'DELETE' && UUID.test(id)) {
    await deleteKey(deps.db, id)
    response.writeHead(204); response.end(); return
  }
  throw new HttpError(404, 'key_not_found')
}

export async function routeJobs(db: Db, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  const id = rest.slice(1)
  if (request.method === 'GET' && UUID.test(id)) {
    const result = await db.query<JobRecord>('select * from ops_jobs where id = $1', [id])
    if (result.rows[0] !== undefined) return sendJson(response, 200, jobView(result.rows[0]))
  }
  throw new HttpError(404, 'job_not_found')
}

export function routeComponents(catalog: readonly Component[], request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed')
  sendJson(response, 200, componentView(catalog))
}

async function listServers(deps: Deps): Promise<Record<string, unknown>[]> {
  const result = await deps.db.query(
    `select s.id, s.name, s.intranet_host, s.ssh_port, s.ssh_user, s.auth_method, s.ssh_key_id,
            s.group_id, g.name as group_name, g.name_i18n as group_name_i18n, g.kind as group_kind,
            s.region, s.auto_install, s.install_component_ids, s.component_status, s.type_key, s.type_snapshot, s.config_revision,
            s.host_key_fingerprint, s.reachability, s.docker_version, s.compose_version, s.cpu_cores, s.cpu_percent,
            s.mem_total_bytes, s.mem_used_bytes, s.disk_total_bytes, s.disk_used_bytes,
            s.metrics_at, s.last_checked_at, s.created_at, s.containers_state, s.containers_checked_at,
            case when s.containers_state = 'ready' then (select count(*)::int from server_containers c where c.server_id = s.id) else null end as container_count
     from servers s left join server_groups g on g.id = s.group_id order by s.name`,
  )
  const options = new Map<string | null, TypeOptions>()
  await Promise.all([...new Set(result.rows.map(row => row.group_id as string | null))].map(async id => {
    try { options.set(id, await deps.definitions.options(id)) } catch (cause) {
      if (!(cause instanceof ServerError) || cause.code !== 'group_not_found') throw cause
      options.set(id, { kind: 'user', available: false, default_type_key: '', types: [] })
    }
  }))
  return result.rows.map(row => {
    const visible = omitSecrets(row)
    const choice = options.get(row.group_id as string | null)!
    const current = choice.types.find(type => type.key === row.type_key)
    const cached = row.type_snapshot as ServerTypeView | null
    const fallback = deps.definitions.defaultOptions().types.find(type => type.key === row.type_key)
    const type = current ?? cached ?? fallback
    const available = choice.available && current !== undefined
    const status = parseJson(row.component_status, {}) as Record<string, { state?: string; installed?: boolean; revision?: string }>
    const required = type?.software ?? []
    for (const item of required) {
      if (status[item.id]?.revision !== item.revision) status[item.id] = { state: 'unknown', installed: false }
    }
    const states = required.map(item => status[item.id]?.state ?? (status[item.id]?.installed === true ? 'installed' : 'unknown'))
    const softwareState = !available ? 'unavailable' : required.length === 0 || states.every(state => state === 'installed') ? 'ready'
      : states.some(state => state === 'missing') ? 'pending' : 'unknown'
    return { ...visible, component_status: status, install_component_ids: required.map(item => item.id),
      type_name_i18n: type?.name_i18n ?? { zh: String(row.type_key), en: String(row.type_key) },
      type_available: available, required_software: required, software_state: softwareState,
    }
  })
}

async function serverDetail(deps: Deps, id: string): Promise<unknown> {
  const server = (await listServers(deps)).find(item => item.id === id)
  if (server === undefined) throw new HttpError(404, 'server_not_found')
  const containers = await deps.db.query('select container_id, name, image, status, ports, managed, strategy_slug, observed_at from server_containers where server_id = $1 order by name', [id])
  const jobs = await deps.db.query('select * from ops_jobs where server_id = $1 order by created_at desc limit 20', [id])
  return { ...server, containers: containers.rows, jobs: jobs.rows.map(jobView) }
}

async function selectType(definitions: DefinitionRegistry, groupId: string | null, key?: string): Promise<TypeLease> {
  const options = await definitions.options(groupId)
  if (!options.available) throw new HttpError(409, 'type_unavailable')
  const selected = key ?? options.default_type_key
  if (!options.types.some(type => type.key === selected)) throw new HttpError(422, 'type_not_found')
  const lease = await definitions.lease(groupId, selected)
  if (lease === undefined) throw new HttpError(409, 'type_unavailable')
  return lease
}

function readonlySoftware(body: unknown): void {
  if (field(body, 'install_component_ids') !== undefined) throw new HttpError(422, 'required_software_readonly')
}

async function createServer(deps: Deps, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'name_required')
  const host = required(text(field(body, 'intranet_host')), 'host_required')
  const port = portOf(field(body, 'ssh_port'))
  const user = required(text(field(body, 'ssh_user')), 'user_required')
  readonlySoftware(body)
  const method = text(field(body, 'auth_method'))
  if (method !== 'private_key' && method !== 'password') throw new HttpError(422, 'auth_required')
  const groupId = await groupOrNull(deps.db, field(body, 'group_id'))
  const region = await regionOf(host, field(body, 'region'))
  let keyId: string | null = null
  let secret = ''
  if (method === 'private_key') {
    keyId = text(field(body, 'ssh_key_id'))
    if (!UUID.test(keyId)) throw new HttpError(422, 'key_required')
    if ((await deps.db.query('select id from ssh_keys where id = $1', [keyId])).rows.length === 0) throw new HttpError(422, 'key_not_found')
  } else {
    secret = required(text(field(body, 'secret')), 'password_required')
  }
  const lease = await selectType(deps.definitions, groupId, field(body, 'type_key') === undefined ? undefined : text(field(body, 'type_key')))
  const id = randomUUID()
  try {
    const client = await deps.db.connect()
    try {
      await client.query('begin')
      await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
      await groupOrNull(client, groupId)
      const auto = field(body, 'auto_install') === true && lease.components.length > 0
      await client.query(
        `insert into servers (id, name, intranet_host, ssh_port, ssh_user, auth_method, secret_ciphertext, ssh_key_id, group_id, region,
          auto_install, install_component_ids, component_status, reachability, type_key, type_snapshot)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}','unknown',$13,$14)`,
        [id, name, host, port, user, method, method === 'password' ? deps.secrets.encrypt(secret) : '', keyId, groupId, region,
          auto, JSON.stringify(lease.components.map(item => item.id)), lease.type.key, JSON.stringify(lease.type)],
      )
      if (auto) await enqueue(client, id, 'test_connection', { configRevision: 0, typeSignature: lease.signature })
      await client.query('commit')
    } catch (cause) {
      await client.query('rollback')
      if (isUnique(cause)) throw new HttpError(409, 'server_exists')
      throw cause
    } finally { client.release() }
  } finally { lease.release() }
  return serverDetail(deps, id)
}

interface EditableServer {
  id: string
  intranet_host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  auto_install: boolean
  install_component_ids: string
  group_id: string | null
  type_key: string
  type_snapshot: ServerTypeView | null
  config_revision: string | number
}

async function updateServer(deps: Deps, id: string, body: unknown): Promise<unknown> {
  readonlySoftware(body)
  const client = await deps.db.connect()
  let lease: TypeLease | undefined
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
    const row = (await client.query<EditableServer>('select id, intranet_host, ssh_port, ssh_user, auth_method, ssh_key_id, auto_install, install_component_ids, group_id, type_key, type_snapshot, config_revision from servers where id = $1 for update', [id])).rows[0]
    if (row === undefined) throw new HttpError(404, 'server_not_found')
    const sets: string[] = []
    const params: unknown[] = [id]
    const assign = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`) }
    const before: RetestSnap = { autoInstall: row.auto_install, host: row.intranet_host, port: row.ssh_port, user: row.ssh_user, method: row.auth_method, keyId: row.ssh_key_id, selection: row.install_component_ids, secretWritten: false }
    const after = { ...before }
    const groupId = field(body, 'group_id') === undefined ? row.group_id : await groupOrNull(client, field(body, 'group_id'))
    const choices = await deps.definitions.options(groupId)
    const key = field(body, 'type_key') !== undefined ? text(field(body, 'type_key'))
      : groupId === row.group_id || choices.types.some(type => type.key === row.type_key) ? row.type_key : choices.default_type_key
    const bindingChanged = groupId !== row.group_id || key !== row.type_key
    lease = bindingChanged ? await selectType(deps.definitions, groupId, key) : await deps.definitions.lease(groupId, key)
    const prior = row.type_snapshot ?? deps.definitions.defaultOptions().types.find(type => type.key === row.type_key)
    if (bindingChanged && lease !== undefined && lease.components.length > 0 && (prior === undefined || !sameSoftware(prior, lease.type))) throw new HttpError(409, 'type_change_requires_preflight')
    if (field(body, 'name') !== undefined) assign('name', required(text(field(body, 'name')), 'name_required'))
    if (field(body, 'intranet_host') !== undefined) { after.host = required(text(field(body, 'intranet_host')), 'host_required'); assign('intranet_host', after.host) }
    if (field(body, 'ssh_port') !== undefined) { after.port = portOf(field(body, 'ssh_port')); assign('ssh_port', after.port) }
    if (field(body, 'ssh_user') !== undefined) { after.user = required(text(field(body, 'ssh_user')), 'user_required'); assign('ssh_user', after.user) }
    if (field(body, 'region') !== undefined) assign('region', await regionOf(after.host, field(body, 'region')))
    after.autoInstall = field(body, 'auto_install') === undefined ? row.auto_install : field(body, 'auto_install') === true
    if (lease !== undefined) {
      if (lease.components.length === 0) after.autoInstall = false
      after.selection = JSON.stringify(lease.components.map(item => item.id))
      if (after.autoInstall && prior !== undefined && !sameSoftware(prior, lease.type)) throw new HttpError(409, 'type_change_requires_preflight')
      assign('type_key', key); assign('type_snapshot', JSON.stringify(lease.type)); assign('install_component_ids', after.selection)
    } else if (after.autoInstall && !row.auto_install) throw new HttpError(409, 'type_unavailable')
    assign('auto_install', after.autoInstall)
    if (bindingChanged) assign('group_id', groupId)
    if (field(body, 'auth_method') !== undefined || field(body, 'ssh_key_id') !== undefined || field(body, 'secret') !== undefined) {
      const method = field(body, 'auth_method') === undefined ? row.auth_method : text(field(body, 'auth_method'))
      if (method === 'private_key') {
        const keyId = field(body, 'ssh_key_id') === undefined ? row.ssh_key_id ?? '' : text(field(body, 'ssh_key_id'))
        if (!UUID.test(keyId)) throw new HttpError(422, 'key_required')
        if ((await client.query('select id from ssh_keys where id = $1', [keyId])).rows.length === 0) throw new HttpError(422, 'key_not_found')
        after.method = 'private_key'; after.keyId = keyId
        assign('auth_method', 'private_key'); assign('ssh_key_id', keyId)
      } else if (method === 'password') {
        const secret = text(field(body, 'secret'))
        if (secret === '' && row.auth_method !== 'password') throw new HttpError(422, 'password_required')
        after.method = 'password'; after.keyId = null; after.secretWritten = secret !== ''
        assign('auth_method', 'password'); assign('ssh_key_id', null)
        if (secret !== '') assign('secret_ciphertext', deps.secrets.encrypt(secret))
      } else throw new HttpError(422, 'auth_required')
    }
    const definitionChanged = lease !== undefined && prior !== undefined && !sameSoftware(prior, lease.type)
    const critical = bindingChanged || definitionChanged || before.host !== after.host || before.port !== after.port || before.user !== after.user || before.method !== after.method
      || before.keyId !== after.keyId || before.autoInstall !== after.autoInstall || before.selection !== after.selection || after.secretWritten
    if (critical) await notRunning(client, id)
    const revision = critical ? String(BigInt(row.config_revision) + 1n) : row.config_revision
    if (critical) assign('config_revision', revision)
    await client.query(`update servers set ${sets.join(', ')}, updated_at = now() where id = $1`, params)
    if (retestAfterEdit(before, after)) await enqueue(client, id, 'test_connection', { configRevision: revision, typeSignature: lease?.signature ?? '' })
    await client.query('commit')
  } catch (cause) {
    await client.query('rollback')
    if (isUnique(cause)) throw new HttpError(409, 'server_exists')
    throw cause
  } finally { client.release(); lease?.release() }
  return serverDetail(deps, id)
}

async function notRunning(db: Db, id: string): Promise<void> {
  if ((await db.query('select id from ops_jobs where server_id = $1 and status = $2 limit 1', [id, 'running'])).rows.length > 0) throw new HttpError(409, 'server_busy')
}

async function enqueueExisting(deps: Deps, id: string, action: string): Promise<JobRecord> {
  const client = await deps.db.connect()
  let lease: TypeLease | undefined
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
    const row = (await client.query<EditableServer>('select id, group_id, type_key, config_revision from servers where id = $1 for update', [id])).rows[0]
    if (row === undefined) throw new HttpError(404, 'server_not_found')
    lease = await deps.definitions.lease(row.group_id, row.type_key)
    if (action === 'install_components' && lease === undefined) throw new HttpError(409, 'type_unavailable')
    if (action === 'install_components' && lease?.components.length === 0) throw new HttpError(422, 'no_required_software')
    const job = await enqueue(client, id, action, { configRevision: row.config_revision, typeSignature: lease?.signature ?? '' })
    await client.query('commit')
    return job
  } catch (cause) { await client.query('rollback'); throw cause } finally { client.release(); lease?.release() }
}

async function deleteServer(db: Db, id: string): Promise<void> {
  const result = await db.query('delete from servers where id = $1 returning id', [id])
  if (result.rows.length === 0) throw new HttpError(404, 'server_not_found')
}

async function preview(body: unknown): Promise<unknown> {
  const host = required(text(field(body, 'intranet_host')), 'host_required')
  const port = portOf(field(body, 'ssh_port'))
  const user = required(text(field(body, 'ssh_user')), 'user_required')
  const method = text(field(body, 'auth_method'))
  const secret = text(field(body, 'secret'))
  if (method === 'private_key' && secret === '') throw new HttpError(422, 'private_key_required')
  if (method === 'password' && secret === '') throw new HttpError(422, 'password_required')
  try {
    const session = await connectSsh({ host, port, username: user, authMethod: method, secret, expectedFingerprint: null })
    const fingerprint = session.fingerprint
    session.close()
    return { ok: true, fingerprint }
  } catch (cause) {
    const error = cause instanceof SshError ? cause : new ServerError('connection_failed')
    return { ok: false, ...errorPayload(error) }
  }
}

async function listGroups(db: Db, definitions: DefinitionRegistry): Promise<unknown[]> {
  const result = await db.query<GroupRecord>(`select g.*, (select count(*)::int from servers s where s.group_id = g.id) as server_count from server_groups g order by sort_order, created_at, id`)
  return result.rows.map(row => definitions.view(row))
}

async function createGroup(db: Db, definitions: DefinitionRegistry, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'group_name_required')
  if (['未分组', '全部服务器', 'ungrouped', 'all servers'].includes(name.toLowerCase())) throw new HttpError(422, 'group_name_reserved')
  if (['kind', 'plugin_id', 'group_key', 'types', 'definition', 'name_i18n'].some(key => field(body, key) !== undefined)) throw new HttpError(422, 'group_source_readonly')
  try {
    const result = await db.query<GroupRecord>('insert into server_groups (id, name) values ($1, $2) returning *', [randomUUID(), name])
    return definitions.view({ ...result.rows[0]!, server_count: 0 })
  } catch (cause) { if (isUnique(cause)) throw new HttpError(409, 'group_exists'); throw cause }
}

async function deleteGroup(db: Db, id: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
    const row = (await client.query<{ kind: string }>('select kind from server_groups where id = $1 for update', [id])).rows[0]
    if (row === undefined) throw new HttpError(404, 'group_not_found')
    if (row.kind === 'system') throw new HttpError(403, 'system_group_protected')
    const servers = await client.query<{ id: string; type_key: string }>('select id, type_key from servers where group_id = $1 for update', [id])
    for (const server of servers.rows) {
      if (server.type_key !== VACANT_TYPE && server.type_key !== GENERAL_TYPE) throw new HttpError(409, 'type_change_requires_preflight')
      await notRunning(client, server.id)
    }
    await client.query('update servers set group_id = null, config_revision = config_revision + 1, updated_at = now() where group_id = $1', [id])
    await client.query('delete from server_groups where id = $1', [id])
    await client.query('commit')
  } catch (cause) { await client.query('rollback'); throw cause } finally { client.release() }
}

async function listKeys(db: Db): Promise<unknown[]> {
  return (await db.query(`select k.id, k.name, k.fingerprint, k.created_at, (select count(*)::int from servers s where s.ssh_key_id = k.id) as server_count from ssh_keys k order by k.name`)).rows
}

async function createKey(deps: Deps, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'name_required')
  const secret = required(text(field(body, 'secret')), 'private_key_required')
  let fingerprint: string
  try { fingerprint = keyFingerprint(secret) } catch (cause) {
    throw new HttpError(422, cause instanceof SshError ? cause.code : 'key_invalid', cause instanceof SshError ? cause.params : {}, { cause })
  }
  try {
    const result = await deps.db.query('insert into ssh_keys (id, name, fingerprint, secret_ciphertext) values ($1, $2, $3, $4) returning id, name, fingerprint, created_at', [randomUUID(), name, fingerprint, deps.secrets.encrypt(secret)])
    return { ...result.rows[0], server_count: 0 }
  } catch (cause) { if (isUnique(cause)) throw new HttpError(409, 'key_exists'); throw cause }
}

async function deleteKey(db: Db, id: string): Promise<void> {
  const count = Number((await db.query<{ count: number }>('select count(*)::int as count from servers where ssh_key_id = $1', [id])).rows[0]?.count ?? 0)
  if (keyInUse(count)) throw new HttpError(409, 'key_in_use')
  if ((await db.query('delete from ssh_keys where id = $1 returning id', [id])).rows.length === 0) throw new HttpError(404, 'key_not_found')
}

function jobView(row: JobRecord | Record<string, unknown>) {
  return { id: row.id, action: row.action, status: row.status, output_excerpt: row.output_excerpt, created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at }
}

const HIDDEN = ['secret_ciphertext', 'secret', 'password', 'private_key']

export function omitSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const visible = { ...row }
  for (const key of HIDDEN) delete visible[key]
  return visible
}

async function containersOf(db: Db, id: string): Promise<unknown[]> {
  if ((await db.query('select id from servers where id = $1', [id])).rows.length === 0) throw new HttpError(404, 'server_not_found')
  return (await db.query('select container_id, name, image, status, ports, managed, strategy_slug, observed_at from server_containers where server_id = $1 order by name', [id])).rows
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback
  try { return JSON.parse(value) } catch (cause) { void cause; return fallback }
}

async function groupOrNull(db: Db, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null
  const id = text(value)
  if (!UUID.test(id)) throw new HttpError(422, 'group_not_found')
  if ((await db.query('select id from server_groups where id = $1', [id])).rows.length === 0) throw new HttpError(422, 'group_not_found')
  return id
}

async function regionOf(host: string, value: unknown): Promise<string | null> {
  const written = typeof value === 'string' ? value : ''
  return written.trim() === '' ? lookupRegion(host) : chosenRegion(host, written, null)
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
