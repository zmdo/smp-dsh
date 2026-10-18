import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Component } from './catalog.ts'
import { keyInUse, shouldRetest } from './jobs.ts'
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
  if (!UUID.test(id)) return sendJson(response, 404, { detail: '服务器不存在' })
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
  sendJson(response, 404, { detail: '服务器不存在' })
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
  sendJson(response, 404, { detail: '分组不存在' })
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
  sendJson(response, 404, { detail: '密钥不存在' })
}

export async function routeJobs(db: Db, request: IncomingMessage, response: ServerResponse, rest: string): Promise<void> {
  const id = rest.slice(1)
  if (request.method === 'GET' && UUID.test(id)) {
    const row = await loadJobView(db, id)
    if (row === undefined) return sendJson(response, 404, { detail: '任务不存在' })
    return sendJson(response, 200, row)
  }
  sendJson(response, 404, { detail: '任务不存在' })
}

export function routeComponents(catalog: readonly Component[], request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET') return sendJson(response, 405, { detail: '不支持的方法' })
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
  if (server === undefined) throw new HttpError(404, '服务器不存在')
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
  const name = required(text(field(body, 'name')), '名称不能为空')
  const host = required(text(field(body, 'intranet_host')), '地址不能为空')
  const port = portOf(field(body, 'ssh_port'))
  const user = required(text(field(body, 'ssh_user')), '用户不能为空')
  const method = text(field(body, 'auth_method'))
  if (method !== 'private_key' && method !== 'password') throw new HttpError(422, '请选择私钥或口令')
  const groupId = await groupOrNull(deps.db, field(body, 'group_id'))
  const region = await regionOf(host, field(body, 'region'))
  const auto = field(body, 'auto_install') === true
  const components = componentIds(deps.catalog, field(body, 'install_component_ids'))
  const id = randomUUID()
  let keyId: string | null = null
  let secret = ''
  if (method === 'private_key') {
    keyId = text(field(body, 'ssh_key_id'))
    if (!UUID.test(keyId)) throw new HttpError(422, '请选择一把密钥')
    const found = await deps.db.query('select id from ssh_keys where id = $1', [keyId])
    if (found.rows[0] === undefined) throw new HttpError(422, '密钥不存在')
  } else {
    secret = text(field(body, 'secret'))
    if (secret === '') throw new HttpError(422, '口令不能为空')
  }
  try {
    await deps.db.query(
      `insert into servers (
         id, name, intranet_host, ssh_port, ssh_user, auth_method, secret_ciphertext, ssh_key_id, group_id, region,
         auto_install, install_component_ids, component_status, reachability
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}','unknown')`,
      [id, name, host, port, user, method, method === 'password' ? deps.secrets.encrypt(secret) : '', keyId, groupId, region, auto, JSON.stringify(components)],
    )
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, '这台机器已经登记过')
    throw cause
  }
  return serverDetail(deps.db, id)
}

async function updateServer(deps: Deps, id: string, body: unknown): Promise<unknown> {
  const current = await deps.db.query(
    'select id, intranet_host, auth_method, auto_install, install_component_ids from servers where id = $1',
    [id],
  )
  const row = current.rows[0] as { intranet_host: string; auth_method: string; auto_install: boolean; install_component_ids: string } | undefined
  if (row === undefined) throw new HttpError(404, '服务器不存在')
  const sets: string[] = []
  const params: unknown[] = [id]
  const assign = (column: string, value: unknown) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (field(body, 'name') !== undefined) assign('name', required(text(field(body, 'name')), '名称不能为空'))
  if (field(body, 'intranet_host') !== undefined) assign('intranet_host', required(text(field(body, 'intranet_host')), '地址不能为空'))
  if (field(body, 'ssh_port') !== undefined) assign('ssh_port', portOf(field(body, 'ssh_port')))
  if (field(body, 'ssh_user') !== undefined) assign('ssh_user', required(text(field(body, 'ssh_user')), '用户不能为空'))
  if (field(body, 'group_id') !== undefined) assign('group_id', await groupOrNull(deps.db, field(body, 'group_id')))
  if (field(body, 'region') !== undefined) assign('region', await regionOf(text(field(body, 'intranet_host')) || row.intranet_host, field(body, 'region')))
  if (field(body, 'auto_install') !== undefined) assign('auto_install', field(body, 'auto_install') === true)
  if (field(body, 'install_component_ids') !== undefined) assign('install_component_ids', JSON.stringify(componentIds(deps.catalog, field(body, 'install_component_ids'))))
  if (field(body, 'ssh_key_id') !== undefined) assign('ssh_key_id', text(field(body, 'ssh_key_id')) || null)
  if (field(body, 'secret') !== undefined && text(field(body, 'secret')) !== '') assign('secret_ciphertext', deps.secrets.encrypt(text(field(body, 'secret'))))
  if (sets.length === 0) return serverDetail(deps.db, id)
  try {
    await deps.db.query(`update servers set ${sets.join(', ')}, updated_at = now() where id = $1`, params)
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, '这台机器已经登记过')
    throw cause
  }
  const connectionChanged = ['intranet_host', 'ssh_port', 'ssh_user', 'ssh_key_id', 'secret'].some(name => field(body, name) !== undefined)
  const selectionChanged = field(body, 'install_component_ids') !== undefined
  const auto = field(body, 'auto_install') === undefined ? row.auto_install : field(body, 'auto_install') === true
  if (shouldRetest({ autoInstall: auto, connectionChanged, selectionChanged })) await enqueue(deps.db, id, 'test_connection')
  return serverDetail(deps.db, id)
}

async function enqueueExisting(db: Db, id: string, action: string): Promise<JobRecord> {
  const found = await db.query('select id from servers where id = $1', [id])
  if (found.rows[0] === undefined) throw new HttpError(404, '服务器不存在')
  return enqueue(db, id, action)
}

async function deleteServer(db: Db, id: string): Promise<void> {
  const result = await db.query('delete from servers where id = $1 returning id', [id])
  if (result.rows[0] === undefined) throw new HttpError(404, '服务器不存在')
}

async function preview(deps: Deps, body: unknown): Promise<unknown> {
  const host = required(text(field(body, 'intranet_host')), '地址不能为空')
  const port = portOf(field(body, 'ssh_port'))
  const user = required(text(field(body, 'ssh_user')), '用户不能为空')
  const method = text(field(body, 'auth_method'))
  const secret = text(field(body, 'secret'))
  if (method === 'private_key' && secret === '') throw new HttpError(422, '请粘贴私钥')
  if (method === 'password' && secret === '') throw new HttpError(422, '口令不能为空')
  try {
    const session = await connectSsh({ host, port, username: user, authMethod: method, secret, expectedFingerprint: null })
    const fingerprint = session.fingerprint
    session.close()
    return { ok: true, fingerprint }
  } catch (cause) {
    const message = cause instanceof SshError ? cause.message : '连接测试失败'
    return { ok: false, detail: message }
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
  const name = required(text(field(body, 'name')), '分组名不能为空')
  if (name === '未分组') throw new HttpError(422, '不能使用这个分组名')
  try {
    const result = await db.query(
      'insert into server_groups (id, name) values ($1, $2) returning id, name, created_at',
      [randomUUID(), name],
    )
    return { ...result.rows[0], server_count: 0 }
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, '分组名已存在')
    throw cause
  }
}

async function deleteGroup(db: Db, id: string): Promise<void> {
  await db.query('update servers set group_id = null, updated_at = now() where group_id = $1', [id])
  const result = await db.query('delete from server_groups where id = $1 returning id', [id])
  if (result.rows[0] === undefined) throw new HttpError(404, '分组不存在')
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
  const name = required(text(field(body, 'name')), '名称不能为空')
  const secret = text(field(body, 'secret'))
  if (secret === '') throw new HttpError(422, '请粘贴私钥')
  let fingerprint = ''
  try {
    fingerprint = keyFingerprint(secret)
  } catch (cause) {
    throw new HttpError(422, cause instanceof SshError ? cause.message : '私钥无法解析')
  }
  try {
    const result = await deps.db.query(
      'insert into ssh_keys (id, name, fingerprint, secret_ciphertext) values ($1, $2, $3, $4) returning id, name, fingerprint, created_at',
      [randomUUID(), name, fingerprint, deps.secrets.encrypt(secret)],
    )
    return { ...result.rows[0], server_count: 0 }
  } catch (cause) {
    if (isUnique(cause)) throw new HttpError(409, '这把密钥已经保存过')
    throw cause
  }
}

async function deleteKey(db: Db, id: string): Promise<void> {
  const used = await db.query('select count(*)::int as count from servers where ssh_key_id = $1', [id])
  const count = Number((used.rows[0] as { count?: number } | undefined)?.count ?? 0)
  if (keyInUse(count)) throw new HttpError(409, '这把密钥还被服务器使用')
  const result = await db.query('delete from ssh_keys where id = $1 returning id', [id])
  if (result.rows[0] === undefined) throw new HttpError(404, '密钥不存在')
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
  if (found.rows[0] === undefined) throw new HttpError(404, '服务器不存在')
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
  if (!UUID.test(id)) throw new HttpError(422, '分组不存在')
  const found = await db.query('select id from server_groups where id = $1', [id])
  if (found.rows[0] === undefined) throw new HttpError(422, '分组不存在')
  return id
}

async function regionOf(host: string, value: unknown): Promise<string | null> {
  const written = typeof value === 'string' ? value : ''
  if (written.trim() !== '') return chosenRegion(host, written, null)
  return lookupRegion(host)
}

function componentIds(catalog: readonly Component[], value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(item => String(item)) : []
  const known = new Set(catalog.map(item => item.id))
  const unknown = raw.find(item => !known.has(item))
  if (unknown !== undefined) throw new HttpError(422, `没有这个组件：${unknown}`)
  return catalog.filter(item => raw.includes(item.id)).map(item => item.id)
}

function portOf(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(422, '端口需要在 1 到 65535 之间')
  return port
}

function required(value: string, message: string): string {
  if (value === '') throw new HttpError(422, message)
  return value
}

function isUnique(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505'
}
