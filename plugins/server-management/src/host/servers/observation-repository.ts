import { randomUUID } from 'node:crypto'
import type { Db } from '../db.ts'
import { type Component } from '../definitions/catalog.ts'
import { type ContainerObservation, type SoftwareStatus } from '../recipes/software.ts'
import { type OsProbe } from '../remote/os-probe.ts'

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
    [
      serverId,
      probe.state,
      os,
      configRevision,
      probe.state === 'failed' ? JSON.stringify({ code: probe.code }) : null,
    ],
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
    [
      serverId,
      observation.state === 'error' ? 'failed' : observation.state,
      observation.detail ? JSON.stringify({ detail: observation.detail }) : null,
    ],
  )
}
