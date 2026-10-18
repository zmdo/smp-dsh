import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorPayload, ServerError, type ErrorCode } from './i18n.ts'
import { CatalogError, normalizeSelection, type Component } from './catalog.ts'
import { keyInUse, retestAfterEdit, type RetestSnap } from './jobs.ts'
import { chosenRegion, lookupRegion } from './region.ts'
import { field, readJson, sendJson, text } from './reply.ts'
import { componentView, enqueue, HttpError, type Db, type JobRecord } from './store.ts'
import { keyFingerprint, SshError, connectSsh } from './ssh.ts'

interface Secrets {
  encrypt(secret: string): string
  decrypt(ciphertext: string): string
}

interface Deps {
  db: Db
  secrets: Secrets
  catalog: readonly Component[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function routeServers(deps: Deps, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listServers(deps.db))
  if (rest === '' && request.method === 'POST') return sendJson(response, 201, await createServer(deps, await readJson(request)))
  if (rest === '/test-connection' && request.method === 'POST') return sendJson(response, 200, await preview(deps, await readJson(request)))
  const parts = rest.split('/').filter(Boolean)
  const id = parts[0] ?? ''
  if (!UUID.test(id)) return sendJson(response, 404, errorPayload(new ServerError('server_not_found')))
  if (parts.length === 1 && request.method === 'GET') return sendJson(response, 200, await serverDetail(deps.db, id))
  if (parts.length === 1 && request.method === 'PATCH') return sendJson(response, 200, await updateServer(deps, id, await readJson(request)))
  if (parts.length === 1 && request.method === 'DELETE') {
    await deleteServer(deps.db, id)
    response.writeHead(204)
    response.end()
    return
  }
  if (parts[1] === 'containers' && parts.length === 2 && request.method === 'GET') return sendJson(response, 200, await containersOf(deps.db, id))
  if (parts[1] === 'test' && request.method === 'POST') return sendJson(response, 202, await jobView(await enqueueExisting(deps.db, id, 'test_connection')))
  if (parts[1] === 'inspect' && request.method === 'POST') return sendJson(response, 202, await jobView(await enqueueExisting(deps.db, id, 'inspect')))
  if (parts[1] === 'install-components' && request.method === 'POST') return sendJson(response, 202, await jobView(await enqueueExisting(deps.db, id, 'install_components')))
  sendJson(response, 404, errorPayload(new ServerError('server_not_found')))
}

export async function routeGroups(db: Db, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listGroups(db))
  if (rest === '' && request.method === 'POST') return sendJson(response, 201, await createGroup(db, await readJson(request)))
  const id = rest.slice(1)
  if (request.method === 'DELETE' && UUID.test(id)) {
    await deleteGroup(db, id)
    response.writeHead(204)
    response.end()
    return
  }
  sendJson(response, 404, errorPayload(new ServerError('group_not_found')))
}

export async function routeKeys(deps: Deps, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  if (rest === '' && request.method === 'GET') return sendJson(response, 200, await listKeys(deps.db))
  if (rest === '' && request.method === 'POST') return sendJson(response, 201, await createKey(deps, await readJson(request)))
  const id = rest.slice(1)
  if (request.method === 'DELETE' && UUID.test(id)) {
    await deleteKey(deps.db, id)
    response.writeHead(204)
    response.end()
    return
  }
  sendJson(response, 404, errorPayload(new ServerError('key_not_found')))
}

export async function routeJobs(db: Db, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  const id = rest.slice(1)
  if (request.method === 'GET' && UUID.test(id)) {
    const row = await loadJobView(db, id)
    if (row === undefined) return sendJson(response, 404, errorPayload(new ServerError('job_not_found')))
    return sendJson(response, 200, row)
  }
  sendJson(response, 404, errorPayload(new ServerError('job_not_found')))
}

export function routeComponents(catalog: readonly Component[], request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET') return sendJson(response, 405, errorPayload(new ServerError('method_not_allowed')))
  sendJson(response, 200, componentView(catalog))
}

async function listServers(db: Db): Promise<unknown[]> {
  const result = await db.query(
    `select s.id, s.name, s.intranet_host, s.ssh_port, s.ssh_user, s.auth_method, s.ssh_key_id,
            s.group_id, g.name as group_name, s.region, s.auto_install, s.install_component_ids, s.component_status,
            s.host_key_fingerprint, s.reachability, s.docker_version, s.compose_version, s.cpu_cores, s.cpu_percent,
            s.mem_total_bytes, s.mem_used_bytes, s.disk_total_bytes, s.disk_used_bytes,
            s.metrics_at, s.last_checked_at, s.created_at,
            (select count(*)::int from server_containers c where c.server_id = s.id) as container_count
     from servers s left join server_groups g on g.id = s.group_id
     order by s.name`,
  )
  return result.rows.map(serverRow)
}

async function serverDetail(db: Db, id: string): Promise<unknown> {
  const servers = await listServers(db)
  const server = servers.find(item => (item as { id: string }).id === id)
  if (server === undefined) throw new HttpError(404, 'server_not_found')
  const containers = await db.query(
    `select container_id, name, image, status, ports, managed, strategy_slug, observed_at
     from server_containers where server_id = $1 order by name`,
    [id],
  )
  const jobs = await db.query(
    `select id, action, status, output_excerpt, created_at, started_at, finished_at
     from ops_jobs where server_id = $1 order by created_at desc limit 20`,
    [id],
  )
  return { ...(server as object), containers: containers.rows.map(containerRow), jobs: jobs.rows.map(jobView) }
}

async function createServer(deps: Deps, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'name_required')
  const host = required(text(field(body, 'intranet_host')), 'host_required')
  const port = portOf(field(body, 'ssh_port'))
  const user = required(text(field(body, 'ssh_user')), 'user_required')
  const method = text(field(body, 'auth_method'))
  if (method !== 'private_key' && method !== 'password') throw new HttpError(422, 'auth_required')
  const groupId = await groupOrNull(deps.db, field(body, 'group_id'))
  const region = await regionOf(host, field(body, 'region'))
  const auto = field(body, 'auto_install') === true
  const components = componentSelection(deps.catalog, auto, field(body, 'install_component_ids'))
  const id = randomUUID()
  let keyId: string | null = null
  let secret = ''
  if (method === 'private_key') {
    keyId = text(field(body, 'ssh_key_id'))
    if (!UUID.test(keyId)) throw new HttpError(422, 'key_required')
    const found = await deps.db.query('select id from ssh_keys where id = $1', [keyId])
    if (found.rows[0] === undefined) throw new HttpError(422, 'key_not_found')
  } else {
    secret = text(field(body, 'secret'))
    if (secret === '') throw new HttpError(422, 'password_required')
  }
  try {
    await deps.db.query(
      `insert into servers (
         id, name, intranet_host, ssh_port, ssh_user, auth_method, secret_ciphertext, ssh_key_id, group_id, region,
         auto_install, install_component_ids, component_status, reachability
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}','unknown')`,
      [id, name, host, port, user, method, method === 'password' ? deps.secrets.encrypt(secret) : '', keyId, groupId, region, auto, components],
    )
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, 'server_exists')
    throw cause
  }
  return serverDetail(deps.db, id)
}

async function updateServer(deps: Deps, id: string, body: unknown): Promise<unknown> {
  const current = await deps.db.query(
    `select id, intranet_host, ssh_port, ssh_user, auth_method, ssh_key_id, auto_install, install_component_ids
     from servers where id = $1`,
    [id],
  )
  const row = current.rows[0] as {
    intranet_host: string
    ssh_port: number
    ssh_user: string
    auth_method: string
    ssh_key_id: string | null
    auto_install: boolean
    install_component_ids: string
  } | undefined
  if (row === undefined) throw new HttpError(404, 'server_not_found')
  const sets: string[] = []
  const params: unknown[] = [id]
  const assign = (column: string, value: unknown) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  const before = snapOf(deps.catalog, row)
  const after: RetestSnap = { ...before, secretWritten: false }
  if (field(body, 'name') !== undefined) assign('name', required(text(field(body, 'name')), 'name_required'))
  if (field(body, 'intranet_host') !== undefined) {
    after.host = required(text(field(body, 'intranet_host')), 'host_required')
    assign('intranet_host', after.host)
  }
  if (field(body, 'ssh_port') !== undefined) {
    after.port = portOf(field(body, 'ssh_port'))
    assign('ssh_port', after.port)
  }
  if (field(body, 'ssh_user') !== undefined) {
    after.user = required(text(field(body, 'ssh_user')), 'user_required')
    assign('ssh_user', after.user)
  }
  if (field(body, 'group_id') !== undefined) assign('group_id', await groupOrNull(deps.db, field(body, 'group_id')))
  if (field(body, 'region') !== undefined) assign('region', await regionOf(after.host, field(body, 'region')))
  if (field(body, 'auto_install') !== undefined || field(body, 'install_component_ids') !== undefined) {
    after.autoInstall = field(body, 'auto_install') === undefined ? row.auto_install : field(body, 'auto_install') === true
    const raw = field(body, 'install_component_ids') === undefined ? parseJson(row.install_component_ids, []) : field(body, 'install_component_ids')
    after.selection = componentSelection(deps.catalog, after.autoInstall, raw)
    assign('auto_install', after.autoInstall)
    assign('install_component_ids', after.selection)
  }
  if (field(body, 'auth_method') !== undefined || field(body, 'ssh_key_id') !== undefined || field(body, 'secret') !== undefined) {
    const method = field(body, 'auth_method') === undefined ? row.auth_method : text(field(body, 'auth_method'))
    if (method === 'private_key') {
      const keyId = field(body, 'ssh_key_id') === undefined ? (row.ssh_key_id ?? '') : text(field(body, 'ssh_key_id'))
      if (!UUID.test(keyId)) throw new HttpError(422, 'key_required')
      const found = await deps.db.query('select id from ssh_keys where id = $1', [keyId])
      if (found.rows[0] === undefined) throw new HttpError(422, 'key_not_found')
      after.method = 'private_key'
      after.keyId = keyId
      assign('auth_method', 'private_key')
      assign('ssh_key_id', keyId)
    } else if (method === 'password') {
      const secret = text(field(body, 'secret'))
      if (secret === '' && row.auth_method !== 'password') throw new HttpError(422, 'password_required')
      after.method = 'password'
      after.keyId = null
      after.secretWritten = secret !== ''
      assign('auth_method', 'password')
      assign('ssh_key_id', null)
      if (secret !== '') assign('secret_ciphertext', deps.secrets.encrypt(secret))
    } else {
      throw new HttpError(422, 'auth_required')
    }
  }
  if (sets.length === 0) return serverDetail(deps.db, id)
  try {
    await deps.db.query(`update servers set ${sets.join(', ')}, updated_at = now() where id = $1`, params)
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, 'server_exists')
    throw cause
  }
  if (retestAfterEdit(before, after)) await enqueue(deps.db, id, 'test_connection')
  return serverDetail(deps.db, id)
}

async function enqueueExisting(db: Db, id: string, action: string): Promise<JobRecord> {
  const found = await db.query('select id from servers where id = $1', [id])
  if (found.rows[0] === undefined) throw new HttpError(404, 'server_not_found')
  return enqueue(db, id, action)
}

async function deleteServer(db: Db, id: string): Promise<void> {
  const result = await db.query('delete from servers where id = $1 returning id', [id])
  if (result.rows[0] === undefined) throw new HttpError(404, 'server_not_found')
}

async function preview(deps: Deps, body: unknown): Promise<unknown> {
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

async function listGroups(db: Db): Promise<unknown[]> {
  const result = await db.query(
    `select g.id, g.name, g.created_at, (select count(*)::int from servers s where s.group_id = g.id) as server_count
     from server_groups g order by g.name`,
  )
  return result.rows
}

async function createGroup(db: Db, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'group_name_required')
  if (['未分组', '全部服务器', 'ungrouped', 'all servers'].includes(name.toLowerCase())) throw new HttpError(422, 'group_name_reserved')
  try {
    const result = await db.query(
      'insert into server_groups (id, name) values ($1, $2) returning id, name, created_at',
      [randomUUID(), name],
    )
    return { ...result.rows[0], server_count: 0 }
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, 'group_exists')
    throw cause
  }
}

async function deleteGroup(db: Db, id: string): Promise<void> {
  await db.query('update servers set group_id = null, updated_at = now() where group_id = $1', [id])
  const result = await db.query('delete from server_groups where id = $1 returning id', [id])
  if (result.rows[0] === undefined) throw new HttpError(404, 'group_not_found')
}

async function listKeys(db: Db): Promise<unknown[]> {
  const result = await db.query(
    `select k.id, k.name, k.fingerprint, k.created_at,
            (select count(*)::int from servers s where s.ssh_key_id = k.id) as server_count
     from ssh_keys k order by k.name`,
  )
  return result.rows
}

async function createKey(deps: Deps, body: unknown): Promise<unknown> {
  const name = required(text(field(body, 'name')), 'name_required')
  const secret = text(field(body, 'secret'))
  if (secret === '') throw new HttpError(422, 'private_key_required')
  let fingerprint = ''
  try {
    fingerprint = keyFingerprint(secret)
  } catch (cause) {
    throw new HttpError(422, cause instanceof SshError ? cause.code : 'key_invalid', cause instanceof SshError ? cause.params : {}, { cause })
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
  const used = await db.query('select count(*)::int as count from servers where ssh_key_id = $1', [id])
  const count = Number((used.rows[0] as { count?: number } | undefined)?.count ?? 0)
  if (keyInUse(count)) throw new HttpError(409, 'key_in_use')
  const result = await db.query('delete from ssh_keys where id = $1 returning id', [id])
  if (result.rows[0] === undefined) throw new HttpError(404, 'key_not_found')
}

async function loadJobView(db: Db, id: string): Promise<unknown | undefined> {
  const result = await db.query(
    'select id, server_id, action, status, output_excerpt, created_at, started_at, finished_at from ops_jobs where id = $1',
    [id],
  )
  const row = result.rows[0] as JobRecord | undefined
  return row === undefined ? undefined : { ...jobView(row), server_id: row.server_id }
}

function jobView(row: JobRecord | Record<string, unknown>): unknown {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    output_excerpt: row.output_excerpt,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }
}

const HIDDEN = ['secret_ciphertext', 'secret', 'password', 'private_key']

/** List and detail responses never carry a stored login secret. */
export function omitSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row }
  for (const key of HIDDEN) delete copy[key]
  return copy
}

function serverRow(row: Record<string, unknown>): unknown {
  const visible = omitSecrets(row)
  return {
    ...visible,
    install_component_ids: parseJson(visible.install_component_ids, []),
    component_status: parseJson(visible.component_status, {}),
  }
}

async function containersOf(db: Db, id: string): Promise<unknown[]> {
  const found = await db.query('select id from servers where id = $1', [id])
  if (found.rows[0] === undefined) throw new HttpError(404, 'server_not_found')
  const containers = await db.query(
    `select container_id, name, image, status, ports, managed, strategy_slug, observed_at
     from server_containers where server_id = $1 order by name`,
    [id],
  )
  return containers.rows
}

function containerRow(row: Record<string, unknown>): unknown {
  return row
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback
  try {
    return JSON.parse(value) as unknown
  } catch (cause) {
    void cause
    return fallback
  }
}

async function groupOrNull(db: Db, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null
  const id = text(value)
  if (!UUID.test(id)) throw new HttpError(422, 'group_not_found')
  const found = await db.query('select id from server_groups where id = $1', [id])
  if (found.rows[0] === undefined) throw new HttpError(422, 'group_not_found')
  return id
}

async function regionOf(host: string, value: unknown): Promise<string | null> {
  const written = typeof value === 'string' ? value : ''
  if (written.trim() !== '') return chosenRegion(host, written, null)
  return lookupRegion(host)
}

function componentSelection(catalog: readonly Component[], auto: boolean, value: unknown): string {
  if (!auto) return '[]'
  const raw = Array.isArray(value) ? value.map(item => String(item)) : []
  let ids: string[]
  try {
    ids = normalizeSelection(catalog, raw)
  } catch (cause) {
    if (cause instanceof CatalogError) throw new HttpError(422, cause.code, cause.params, { cause })
    throw cause
  }
  if (ids.length === 0) throw new HttpError(422, 'components_required')
  return JSON.stringify(ids)
}

function snapOf(catalog: readonly Component[], row: { intranet_host: string; ssh_port: number; ssh_user: string; auth_method: string; ssh_key_id: string | null; auto_install: boolean; install_component_ids: string }): RetestSnap {
  let selection = '[]'
  if (row.auto_install) {
    try {
      selection = componentSelection(catalog, true, parseJson(row.install_component_ids, []))
    } catch (cause) {
      void cause
      selection = row.install_component_ids
    }
  }
  return {
    autoInstall: row.auto_install,
    host: row.intranet_host,
    port: Number(row.ssh_port),
    user: row.ssh_user,
    method: row.auth_method,
    keyId: row.ssh_key_id,
    selection,
    secretWritten: false,
  }
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
