import { randomUUID } from 'node:crypto'
import type { Component } from './catalog.ts'
import { excerpt } from './parse.ts'
import type { MetricSample } from './parse.ts'
import { ServerError, type ErrorCode, type MessageParams } from './i18n.ts'
import type { ContainerObservation, SoftwareStatus } from './software.ts'
import type { DeclaredOs, DetectedOs } from './operating-systems.ts'
import type { OsProbe } from './os-probe.ts'

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  connect(): Promise<DbClient>
}

export interface DbClient extends Db {
  release(): void
}

export class HttpError extends ServerError {
  readonly status: number

  constructor(status: number, code: ErrorCode, params: MessageParams = {}, options?: ErrorOptions) {
    super(code, params, options)
    this.name = 'HttpError'
    this.status = status
  }
}

export { enqueue, enqueueOn, claimNext } from './job-store.ts'
export type { JobRecord } from './job-store.ts'

export interface ServerSecret {
  id: string
  host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  secret_ciphertext: string
  host_fingerprint: string | null
  install_required_software: boolean
  declared_os: DeclaredOs
  detected_os: DetectedOs | null
  os_probe_state: string
  observed_config_revision: string | number
  environment_revision: string | number
  group_id: string | null
  type_key: string
  config_revision: string | number
}

export async function serverSecret(db: Db, id: string): Promise<ServerSecret | undefined> {
  const result = await db.query<ServerSecret>(
    `select s.id, s.host, s.ssh_port, s.ssh_user, s.auth_method,
            case when s.auth_method = 'private_key' then k.secret_ciphertext else s.secret_ciphertext end as secret_ciphertext,
            s.host_fingerprint, s.install_required_software, s.declared_os, r.detected_os, r.os_probe_state, r.observed_config_revision, r.environment_revision, s.group_id, s.type_key, s.config_revision
     from servers s join server_runtime r on r.server_id=s.id left join ssh_keys k on k.id = s.ssh_key_id where s.id = $1`,
    [id],
  )
  return result.rows[0]
}

export async function markConnected(db: Db, serverId: string, fingerprint: string): Promise<void> {
  await db.query('update servers set host_fingerprint = $2 where id = $1 and host_fingerprint is null', [
    serverId,
    fingerprint,
  ])
  await db.query(
    "update server_runtime set connection_state='online', connection_error=null, connection_checked_at=now() where server_id=$1",
    [serverId],
  )
}

export async function saveOsProbe(
  db: Db,
  serverId: string,
  probe: OsProbe,
  configRevision: string | number,
): Promise<void> {
  const os = probe.state === 'detected' ? JSON.stringify(probe.os) : null
  await db.query(
    `update server_runtime set os_probe_state=$2, os_checked_at=now(), observed_config_revision=$4,
    os_error=$5, environment_revision=environment_revision+case when $3::jsonb is not null and detected_os is distinct from $3::jsonb then 1 else 0 end,
    detected_os=coalesce($3::jsonb,detected_os), os_last_success_at=case when $3::jsonb is not null then now() else os_last_success_at end
    where server_id=$1`,
    [serverId, probe.state, os, configRevision, probe.state === 'failed' ? JSON.stringify({ code: probe.code }) : null],
  )
}

type ObservedComponent = Pick<Component, 'id' | 'software_key' | 'recipe'>

export async function saveComponentStatus(
  db: Db,
  serverId: string,
  status: SoftwareStatus,
  components: readonly ObservedComponent[],
): Promise<void> {
  for (const component of components) {
    const item = status[component.id]
    if (!item) continue
    await db.query(
      `insert into server_software_observations
      (server_id,software_key,probe_state,checked_at,error,observed_config_revision,observed_environment_revision,recipe_key,recipe_revision,last_known_state,product_version,target_identity,healthy,last_success_at,packages)
      select s.id,$2,$3,now(),$4,s.config_revision,r.environment_revision,$5,$6,
        case when $3='unknown' then null else $3 end,$7,$8,case when $3='installed' then $9::boolean else null end,case when $3='unknown' then null else now() end,$10::jsonb
      from servers s join server_runtime r on r.server_id=s.id where s.id=$1
      on conflict(server_id,software_key) do update set probe_state=excluded.probe_state,checked_at=excluded.checked_at,error=excluded.error,
        observed_config_revision=excluded.observed_config_revision,observed_environment_revision=excluded.observed_environment_revision,
        recipe_key=excluded.recipe_key,recipe_revision=excluded.recipe_revision,
        last_known_state=case when excluded.probe_state='unknown' then server_software_observations.last_known_state else excluded.last_known_state end,
        product_version=case when excluded.probe_state='unknown' then server_software_observations.product_version else excluded.product_version end,
        target_identity=case when excluded.probe_state='unknown' then server_software_observations.target_identity else excluded.target_identity end,
        healthy=case when excluded.probe_state='unknown' then server_software_observations.healthy else excluded.healthy end,
        packages=case when excluded.probe_state='unknown' then server_software_observations.packages else excluded.packages end,
        last_success_at=coalesce(excluded.last_success_at,server_software_observations.last_success_at)`,
      [
        serverId,
        component.software_key,
        item.state,
        item.detail ? JSON.stringify({ detail: item.detail }) : null,
        component.recipe,
        item.revision ?? 'optional-observation',
        item.state === 'installed' ? item.version : null,
        item.state === 'installed' ? (item.targetIdentity ?? item.version) : null,
        item.healthy ?? true,
        JSON.stringify(item.packages ?? []),
      ],
    )
  }
}

export async function saveObservation(
  db: Db,
  serverId: string,
  jobId: string,
  status: SoftwareStatus | undefined,
  observation: ContainerObservation,
  output: string,
  components: readonly Component[],
): Promise<void> {
  const client = db
  if (status !== undefined) await saveComponentStatus(client, serverId, status, components)
  for (const [id, version] of [
    ['docker', observation.docker],
    ['compose', observation.compose],
  ] as const) {
    if (version === null || status?.[id]) continue
    await saveComponentStatus(
      client,
      serverId,
      { [id]: { state: 'installed', installed: true, version, detail: '' } },
      [
        {
          id,
          software_key: id === 'docker' ? 'builtin/docker-engine' : 'builtin/docker-compose',
          recipe: 'builtin/container-observation',
        },
      ],
    )
  }
  if (observation.state === 'ready') {
    await client.query('delete from server_containers where server_id = $1', [serverId])
    for (const item of observation.containers ?? [])
      await client.query(
        `insert into server_containers (id,server_id,container_id,name,image,status,ports,managed,strategy_slug,observed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
        [
          randomUUID(),
          serverId,
          item.containerId,
          item.name,
          item.image,
          item.status,
          item.ports,
          item.managed,
          item.strategySlug,
        ],
      )
  }
  await client.query(
    `insert into server_container_scans(server_id,state,checked_at,last_success_at,error) values($1,$2,now(),case when $2='ready' then now() else null end,$3)
      on conflict(server_id) do update set state=excluded.state,checked_at=excluded.checked_at,last_success_at=coalesce(excluded.last_success_at,server_container_scans.last_success_at),error=excluded.error`,
    [serverId, observation.state === 'error' ? 'failed' : observation.state, observation.detail ? JSON.stringify({ detail: observation.detail }) : null],
  )
}

export async function saveMetrics(
  db: Db,
  serverId: string,
  sample: MetricSample,
  configRevision: string | number,
): Promise<void> {
  await db.query(
    `update server_runtime r set cpu_cores=$2,cpu_percent=$3,memory_total_bytes=$4,memory_used_bytes=$5,disk_total_bytes=$6,disk_used_bytes=$7,metrics_sampled_at=now(),metrics_error=null
    from servers s where r.server_id=s.id and s.id=$1 and s.config_revision=$8`,
    [
      serverId,
      sample.cpuCores,
      sample.cpuPercent,
      sample.memTotalBytes,
      sample.memUsedBytes,
      sample.diskTotalBytes,
      sample.diskUsedBytes,
      configRevision,
    ],
  )
}

export async function dueInspects(db: Db, intervalSeconds: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `select s.id from servers s join server_runtime r on r.server_id=s.id
    where r.connection_state='online' and (r.connection_checked_at is null or r.connection_checked_at < now()-make_interval(secs=>$1))
    and not exists(select 1 from server_jobs j where j.server_id=s.id and j.purpose='inspect' and j.state in ('queued','claimed','running','recovering'))`,
    [intervalSeconds],
  )
  return result.rows.map((row) => row.id)
}

export async function serverIds(db: Db): Promise<string[]> {
  const result = await db.query<{ id: string }>(`select s.id from servers s join server_runtime r on r.server_id=s.id
    where r.os_probe_state='detected' and r.detected_os->>'family' <> 'builtin/windows-server' and r.observed_config_revision=s.config_revision`)
  return result.rows.map((row) => row.id)
}

export function componentView(
  catalog: readonly Component[],
): { id: string; name: string; summary: string; requires: string[] }[] {
  return catalog.map((item) => ({ id: item.id, name: item.name, summary: item.summary, requires: item.requires }))
}
