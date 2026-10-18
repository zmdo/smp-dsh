import { randomUUID } from 'node:crypto'
import type { Component } from './catalog.ts'
import { RESTART_MESSAGE } from './jobs.ts'
import { excerpt } from './parse.ts'
import type { ParsedContainer } from './parse.ts'
import type { MetricSample } from './parse.ts'

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  connect(): Promise<DbClient>
}

export interface DbClient extends Db {
  release(): void
}

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export interface JobRecord {
  id: string
  server_id: string
  action: string
  status: string
  output_excerpt: string
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

const JOB_COLUMNS = 'id, server_id, action, status, output_excerpt, created_at, started_at, finished_at'

export async function recoverRunning(db: Db): Promise<void> {
  await db.query(
    `update ops_jobs set status = 'failed', finished_at = now(), output_excerpt = $1 where status = 'running'`,
    [RESTART_MESSAGE],
  )
}

export async function enqueue(db: Db, serverId: string, action: string): Promise<JobRecord> {
  const existing = await db.query<JobRecord>(
    `select ${JOB_COLUMNS} from ops_jobs where server_id = $1 and action = $2 and status in ('queued', 'running') order by created_at limit 1`,
    [serverId, action],
  )
  const open = existing.rows[0]
  if (open !== undefined) return open
  const id = randomUUID()
  const inserted = await db.query<JobRecord>(
    `insert into ops_jobs (id, server_id, action, status, output_excerpt) values ($1, $2, $3, 'queued', '') returning ${JOB_COLUMNS}`,
    [id, serverId, action],
  )
  const row = inserted.rows[0]
  if (row === undefined) throw new HttpError(500, '任务没有写入')
  return row
}

export async function claimNext(db: Db): Promise<string | undefined> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const found = await client.query<{ id: string }>(
      `select id from ops_jobs
       where status = 'queued'
         and server_id not in (select server_id from ops_jobs where status = 'running')
       order by created_at
       for update skip locked
       limit 1`,
    )
    const id = found.rows[0]?.id
    if (id === undefined) {
      await client.query('commit')
      return undefined
    }
    await client.query(`update ops_jobs set status = 'running', started_at = now() where id = $1`, [id])
    await client.query('commit')
    return id
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}

export async function loadJob(db: Db, id: string): Promise<JobRecord | undefined> {
  const result = await db.query<JobRecord>(`select ${JOB_COLUMNS} from ops_jobs where id = $1`, [id])
  return result.rows[0]
}

export interface ServerSecret {
  id: string
  intranet_host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  secret_ciphertext: string
  host_key_fingerprint: string | null
  auto_install: boolean
  install_component_ids: string
}

export async function serverSecret(db: Db, id: string): Promise<ServerSecret | undefined> {
  const result = await db.query<ServerSecret>(
    `select s.id, s.intranet_host, s.ssh_port, s.ssh_user, s.auth_method,
            case when s.auth_method = 'private_key' and k.secret_ciphertext is not null then k.secret_ciphertext else s.secret_ciphertext end as secret_ciphertext,
            s.host_key_fingerprint, s.auto_install, s.install_component_ids
     from servers s left join ssh_keys k on k.id = s.ssh_key_id where s.id = $1`,
    [id],
  )
  return result.rows[0]
}

export async function finishJob(db: Db, id: string, status: 'succeeded' | 'failed', message: string): Promise<void> {
  await db.query(
    `update ops_jobs set status = $2, finished_at = now(), output_excerpt = $3 where id = $1 and status = 'running'`,
    [id, status, excerpt(message)],
  )
}

export async function saveProbe(db: Db, serverId: string, jobId: string, fingerprint: string, dockerVersion: string, composeVersion: string, output: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query(
      `update servers set host_key_fingerprint = $2, docker_version = $3, compose_version = $4, reachability = 'online', last_checked_at = now(), updated_at = now() where id = $1`,
      [serverId, fingerprint, dockerVersion, composeVersion],
    )
    await client.query(
      `update ops_jobs set status = 'succeeded', finished_at = now(), output_excerpt = $2 where id = $1`,
      [jobId, excerpt(output)],
    )
    await client.query(
      `insert into ops_jobs (id, server_id, action, status, output_excerpt)
       select $1, $2, 'inspect', 'queued', ''
       where not exists (
         select 1 from ops_jobs where server_id = $2 and action = 'inspect' and status in ('queued', 'running')
       )`,
      [randomUUID(), serverId],
    )
    await client.query('commit')
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}

export async function saveFailure(db: Db, serverId: string, jobId: string, message: string, dockerDown: boolean, fingerprint: string | undefined, pin: boolean): Promise<void> {
  await db.query(
    `update servers set
       reachability = $2,
       last_checked_at = now(),
       updated_at = now(),
       docker_version = case when $3 then null else docker_version end,
       compose_version = case when $3 then null else compose_version end,
       host_key_fingerprint = case when $4 and host_key_fingerprint is null then $5 else host_key_fingerprint end
     where id = $1`,
    [serverId, dockerDown ? 'docker_unavailable' : 'offline', dockerDown, pin, fingerprint ?? null],
  )
  await finishJob(db, jobId, 'failed', message)
}

export async function replaceContainers(db: Db, serverId: string, jobId: string, containers: ParsedContainer[], output: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query('delete from server_containers where server_id = $1', [serverId])
    for (const item of containers) {
      await client.query(
        `insert into server_containers (id, server_id, container_id, name, image, status, ports, managed, strategy_slug, observed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
        [randomUUID(), serverId, item.containerId, item.name, item.image, item.status, item.ports, item.managed, item.strategySlug],
      )
    }
    await client.query(
      `update servers set reachability = 'online', last_checked_at = now(), updated_at = now() where id = $1`,
      [serverId],
    )
    await client.query(
      `update ops_jobs set status = 'succeeded', finished_at = now(), output_excerpt = $2 where id = $1`,
      [jobId, excerpt(output)],
    )
    await client.query('commit')
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}

export async function saveComponentStatus(db: Db, serverId: string, status: Record<string, { installed: boolean; detail: string }>): Promise<void> {
  await db.query(`update servers set component_status = $2, updated_at = now() where id = $1`, [serverId, JSON.stringify(status)])
}

export async function saveMetrics(db: Db, serverId: string, sample: MetricSample): Promise<void> {
  await db.query(
    `update servers set cpu_cores = $2, cpu_percent = $3, mem_total_bytes = $4, mem_used_bytes = $5, disk_total_bytes = $6, disk_used_bytes = $7, metrics_at = now() where id = $1`,
    [serverId, sample.cpuCores, sample.cpuPercent, sample.memTotalBytes, sample.memUsedBytes, sample.diskTotalBytes, sample.diskUsedBytes],
  )
}

export async function dueInspects(db: Db, intervalSeconds: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `select id from servers
     where reachability = 'online'
       and (last_checked_at is null or last_checked_at < now() - make_interval(secs => $1))
       and not exists (
         select 1 from ops_jobs where ops_jobs.server_id = servers.id and action = 'inspect' and status in ('queued', 'running')
       )`,
    [intervalSeconds],
  )
  return result.rows.map(row => row.id)
}

export async function serverIds(db: Db): Promise<string[]> {
  const result = await db.query<{ id: string }>('select id from servers')
  return result.rows.map(row => row.id)
}

export function componentView(catalog: readonly Component[]): { id: string; name: string; summary: string; requires: string[] }[] {
  return catalog.map(item => ({ id: item.id, name: item.name, summary: item.summary, requires: item.requires }))
}
