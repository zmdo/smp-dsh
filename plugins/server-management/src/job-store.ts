import { randomUUID } from 'node:crypto'
import type { Db, DbClient, ServerSecret } from './store.ts'
import { ServerError } from './i18n.ts'
import { digest } from './recipe.ts'
import type { PreparedPlan } from './plans.ts'

export interface JobRecord {
  id: string
  server_id: string
  server_identity: string
  purpose: 'inspect' | 'apply_plan'
  state: string
  phase: string
  mutation_phase: string | null
  expected_config_revision: string
  expected_environment_revision: string
  definition_revision: string
  target_id: string | null
  operation_id: string
  worker_id: string
  fence: string
  lease_expires_at: Date
  request_snapshot: { action: string; prepare?: boolean }
  result: unknown
  output_excerpt: string
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}
export const LEASE_SECONDS = 60
export async function enqueue(
  db: Db,
  serverId: string,
  action: string,
  expected?: { configRevision: string | number; typeSignature: string },
  prepare = false,
): Promise<JobRecord> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const result = await enqueueOn(client, serverId, action, expected, prepare)
    await client.query('commit')
    return result
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}
/** Call while the server row is locked; works inside registration/edit transactions. */
export async function enqueueOn(
  db: Db,
  serverId: string,
  action: string,
  expected?: { configRevision: string | number; typeSignature: string },
  prepare = false,
): Promise<JobRecord> {
  const server = (
    await db.query<{ config_revision: string; environment_revision: string }>(
      'select s.config_revision,r.environment_revision from servers s join server_runtime r on r.server_id=s.id where s.id=$1 for update of s',
      [serverId],
    )
  ).rows[0]
  if (!server) throw new ServerError('server_not_found')
  const request = { action, prepare: prepare || action === 'install_components' }
  const existing = (
    await db.query<JobRecord>(
      `select * from server_jobs where server_id=$1 and purpose='inspect' and state in ('queued','claimed','running','recovering')
    and expected_config_revision=$2 and request_snapshot=$3::jsonb order by created_at limit 1`,
      [serverId, expected?.configRevision ?? server.config_revision, JSON.stringify(request)],
    )
  ).rows[0]
  if (existing) return existing
  const id = randomUUID()
  return (
    await db.query<JobRecord>(
      `insert into server_jobs(id,server_id,server_identity,purpose,expected_config_revision,expected_environment_revision,definition_revision,idempotency_key,operation_id,request_snapshot)
    values($1,$2,$2,'inspect',$3,$4,$5,$1::uuid::text,$6,$7) returning *`,
      [
        id,
        serverId,
        expected?.configRevision ?? server.config_revision,
        server.environment_revision,
        expected?.typeSignature ?? '',
        randomUUID(),
        JSON.stringify(request),
      ],
    )
  ).rows[0]!
}
export async function claimNext(db: Db, workerId: string): Promise<JobRecord | undefined> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const found = (
      await client.query<JobRecord>(`select j.* from server_jobs j
      where (j.state in ('claimed','running','recovering') and j.lease_expires_at<now())
        or (j.state='queued' and not exists(select 1 from server_jobs active where active.server_id=j.server_id and active.state in ('claimed','running','recovering')))
      order by case when j.state='queued' then 1 else 0 end,j.created_at,j.id for update of j skip locked limit 1`)
    ).rows[0]
    if (!found) {
      await client.query('commit')
      return
    }
    if (
      !(await client.query('select id from servers where id=$1 for update skip locked', [found.server_id])).rows.length
    ) {
      await client.query('commit')
      return
    }
    if (
      found.state === 'queued' &&
      (
        await client.query(
          "select id from server_jobs where server_id=$1 and state in ('claimed','running','recovering')",
          [found.server_id],
        )
      ).rows.length
    ) {
      await client.query('commit')
      return
    }
    const state = found.state === 'queued' ? 'running' : 'recovering'
    const claimed = (
      await client.query<JobRecord>(
        `update server_jobs set state=$2,phase=case when $2='recovering' then 'reconciling' else 'connecting' end,
      worker_id=$3,fence=fence+1,lease_expires_at=now()+make_interval(secs=>$4),heartbeat_at=now(),started_at=coalesce(started_at,now()) where id=$1 returning *`,
        [found.id, state, workerId, LEASE_SECONDS],
      )
    ).rows[0]!
    await client.query('commit')
    return claimed
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}
export async function heartbeat(db: Db, job: JobRecord): Promise<boolean> {
  const result = await db.query(
    `update server_jobs set heartbeat_at=now(),lease_expires_at=now()+make_interval(secs=>$4)
    where id=$1 and worker_id=$2 and fence=$3 and state in ('running','recovering') and lease_expires_at>now() returning id`,
    [job.id, job.worker_id, job.fence, LEASE_SECONDS],
  )
  return result.rows.length > 0
}
export async function owned<T>(db: Db, job: JobRecord, run: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const locked = await client.query(
      `select id from server_jobs where id=$1 and worker_id=$2 and fence=$3 and state in ('running','recovering') and lease_expires_at>now() for update`,
      [job.id, job.worker_id, job.fence],
    )
    if (!locked.rows.length) throw new ServerError('job_lease_lost')
    await client.query('select id from servers where id=$1 for update', [job.server_id])
    const value = await run(client)
    await client.query('commit')
    return value
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}
export async function phase(db: Db, job: JobRecord, next: string): Promise<void> {
  await owned(db, job, async (client) => {
    await client.query(
      "update server_jobs set phase=$2,mutation_phase=case when $2='installing' then 'installing' else mutation_phase end where id=$1",
      [job.id, next],
    )
  })
  job.phase = next
}
export async function finishJob(
  db: Db,
  job: JobRecord,
  state: 'succeeded' | 'failed' | 'blocked',
  message: string,
  result: unknown = null,
): Promise<void> {
  await owned(db, job, async (client) => {
    await client.query(
      "update server_jobs set state=$2,phase='finished',output_excerpt=$3,result=$4,finished_at=now() where id=$1",
      [job.id, state, message.slice(-4000), JSON.stringify(result)],
    )
    if (job.purpose === 'inspect' && job.request_snapshot.action === 'inspect' && !job.request_snapshot.prepare) {
      await client.query(
        `insert into server_inspection_reports(server_identity,hour_start,succeeded,failed,last_checked_at)
        select server_identity,date_trunc('hour',finished_at at time zone 'UTC') at time zone 'UTC',
          case when state='succeeded' then 1 else 0 end,case when state='succeeded' then 0 else 1 end,finished_at
        from server_jobs where id=$1
        on conflict(server_identity,hour_start) do update set
          succeeded=server_inspection_reports.succeeded+excluded.succeeded,
          failed=server_inspection_reports.failed+excluded.failed,
          last_checked_at=greatest(server_inspection_reports.last_checked_at,excluded.last_checked_at)`,
        [job.id],
      )
    }
    if (job.target_id) {
      const target = (
        await client.query<{ plan_id: string }>(
          'update server_change_targets set state=$2,result=$3,finished_at=now() where id=$1 returning plan_id',
          [job.target_id, state === 'succeeded' ? 'succeeded' : state, JSON.stringify(result)],
        )
      ).rows[0]!
      await client.query("update server_change_plans set state=$2,updated_at=now() where id=$1 and state<>'missed'", [
        target.plan_id,
        state === 'succeeded' ? 'completed' : 'partial_failure',
      ])
    }
  })
}
export async function recovering(db: Db, job: JobRecord, message: string): Promise<void> {
  await owned(db, job, async (client) => {
    await client.query(
      "update server_jobs set state='recovering',phase='reconciling',output_excerpt=$2,lease_expires_at=now()+interval '30 seconds' where id=$1",
      [job.id, message.slice(-4000)],
    )
  })
}
export async function savePlan(db: Db, job: JobRecord, server: ServerSecret, plan: PreparedPlan): Promise<void> {
  await owned(db, job, async (client) => {
    const current = (
      await client.query<{ config_revision: string }>('select config_revision from servers where id=$1', [server.id])
    ).rows[0]!
    if (String(current.config_revision) !== String(server.config_revision))
      throw new ServerError('job_configuration_changed')
    if ((await client.query('select id from server_change_plans where id=$1', [job.id])).rows.length) return
    const id = job.id,
      target = randomUUID(),
      child = randomUUID()
    const window = { start: new Date().toISOString(), end: new Date(Date.now() + 15 * 60_000).toISOString() }
    const confirmation = {
      plan,
      serverId: server.id,
      configRevision: String(server.config_revision),
      environmentRevision: String(server.environment_revision),
      window,
      concurrency: 1,
    }
    const fingerprint = digest(confirmation)
    await client.query(
      `insert into server_change_plans(id,kind,state,confirmation_digest,confirmed_by,confirmed_at,authorization_kind,window_start,window_end,timezone,request_snapshot)
      values($1,'prepare','scheduled',$2,$3,now(),'missing_software_only',$4,$5,'UTC',$6)`,
      [
        id,
        fingerprint,
        job.request_snapshot.action === 'install_components' ? 'authenticated-install-request' : 'saved-install-choice',
        window.start,
        window.end,
        JSON.stringify(confirmation),
      ],
    )
    await client.query(
      `insert into server_change_targets(id,plan_id,server_id,server_identity,server_snapshot,expected_config_revision,expected_environment_revision,definition_revision,target_snapshot)
      values($1,$2,$3,$3,$4,$5,$6,$7,$8)`,
      [
        target,
        id,
        server.id,
        JSON.stringify({ host: server.host, port: server.ssh_port }),
        server.config_revision,
        server.environment_revision,
        plan.definitionRevision,
        JSON.stringify(plan),
      ],
    )
    await client.query(
      `insert into server_jobs(id,server_id,server_identity,target_id,purpose,expected_config_revision,expected_environment_revision,definition_revision,idempotency_key,operation_id,request_snapshot)
      values($1,$2,$2,$3,'apply_plan',$4,$5,$6,$1::uuid::text,$7,$8)`,
      [
        child,
        server.id,
        target,
        server.config_revision,
        server.environment_revision,
        plan.definitionRevision,
        randomUUID(),
        JSON.stringify({ action: 'install_components', planId: id, digest: fingerprint }),
      ],
    )
  })
}
export async function loadPlan(db: Db, job: JobRecord): Promise<{ plan: PreparedPlan; digest: string } | undefined> {
  return owned(db, job, async (client) => {
    const row = (
      await client.query<{
        target_snapshot: PreparedPlan
        confirmation_digest: string
        state: string
        window_end: Date
        request_snapshot: unknown
      }>(
        `select t.target_snapshot,p.confirmation_digest,p.state,p.window_end,p.request_snapshot from server_change_targets t join server_change_plans p on p.id=t.plan_id
      where t.id=$1 and t.server_id=$2 and t.expected_config_revision=$3 and t.definition_revision=$4 and p.confirmed_at is not null for update of p,t`,
        [job.target_id, job.server_id, job.expected_config_revision, job.definition_revision],
      )
    ).rows[0]
    if (
      !row ||
      !['scheduled', 'running'].includes(row.state) ||
      digest(row.request_snapshot) !== row.confirmation_digest ||
      digest((row.request_snapshot as { plan: unknown }).plan) !== digest(row.target_snapshot)
    )
      return
    if (job.mutation_phase === null && row.window_end.getTime() < Date.now()) {
      await client.query(
        "update server_change_plans p set state='missed' from server_change_targets t where p.id=t.plan_id and t.id=$1",
        [job.target_id],
      )
      return
    }
    await client.query("update server_change_targets set state='running' where id=$1", [job.target_id])
    await client.query(
      "update server_change_plans p set state='running' from server_change_targets t where p.id=t.plan_id and t.id=$1",
      [job.target_id],
    )
    return { plan: row.target_snapshot, digest: row.confirmation_digest }
  })
}
