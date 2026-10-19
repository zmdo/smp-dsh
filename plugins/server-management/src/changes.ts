import { randomUUID } from 'node:crypto'
import type { Db, JobRecord, ServerSecret } from './store.ts'
import { HttpError } from './store.ts'
import { canonical, digest } from './recipe.ts'
import type { PreparedPlan } from './plans.ts'
import { parsePolicies, readPolicies, restrictLease, writePolicies, type SoftwarePolicy } from './policies.ts'
import type { DefinitionRegistry } from './registry.ts'
import { ServerError } from './i18n.ts'
import type { ServerTypeView } from './definitions.ts'

export interface ChangeSelection {
  serverIds: string[]
  versions: Record<string, string>
  binding?: { groupId: string | null; typeKey: string; installMissing: boolean; policies: SoftwarePolicy[] }
}
export interface ChangeRequest {
  selection: ChangeSelection
  targets?: {
    id: string
    serverId: string
    configRevision: string
    environmentRevision: string
    definitionRevision: string
    plan: PreparedPlan
  }[]
  execution?: { start: string; end: string; timezone: string; concurrency: number }
  acknowledgments?: { replacement: boolean; major: boolean; serviceImpact: boolean }
}
export interface PlanRow {
  id: string
  kind: 'prepare' | 'move' | 'upgrade'
  state: string
  revision: string
  request_snapshot: ChangeRequest
  confirmation_digest: string | null
  window_start: Date | null
  window_end: Date | null
  concurrency: number
}
const UUID = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i
export async function transaction<T>(db: Db, run: (db: Db) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('begin')
    const v = await run(c)
    await c.query('commit')
    return v
  } catch (cause) {
    await c.query('rollback')
    throw cause
  } finally {
    c.release()
  }
}
export async function createChangePlan(
  db: Db,
  definitions: DefinitionRegistry,
  input: unknown,
): Promise<string> {
  if (!input || typeof input !== 'object') throw new ServerError('upgrade_invalid')
  const value = input as Record<string, unknown>,
    kind = value.kind
  if (kind !== 'move' && kind !== 'upgrade') throw new ServerError('upgrade_invalid')
  if (
    !Array.isArray(value.server_ids) ||
    !value.server_ids.length ||
    value.server_ids.length > 500 ||
    value.server_ids.some((id) => typeof id !== 'string' || !UUID.test(id))
  )
    throw new ServerError('upgrade_invalid')
  const ids = [...new Set(value.server_ids as string[])].sort()
  const versions: Record<string, string> = {}
  if (kind === 'upgrade') {
    if (!value.versions || typeof value.versions !== 'object' || Array.isArray(value.versions))
      throw new ServerError('upgrade_invalid')
    for (const [key, version] of Object.entries(value.versions)) {
      if (typeof version !== 'string' || version.length > 128 || key.length > 200)
        throw new ServerError('upgrade_invalid')
      versions[key] = version
    }
    if (!Object.keys(versions).length) throw new ServerError('upgrade_invalid')
  }
  let binding: ChangeSelection['binding']
  if (kind === 'move') {
    if (
      ids.length !== 1 ||
      (value.group_id !== null && (typeof value.group_id !== 'string' || !UUID.test(value.group_id))) ||
      typeof value.type_key !== 'string' ||
      typeof value.install_missing !== 'boolean'
    )
      throw new ServerError('upgrade_invalid')
    binding = {
      groupId: value.group_id as string | null,
      typeKey: value.type_key,
      installMissing: value.install_missing,
      policies: parsePolicies(value.software_policies),
    }
  }
  const selection: ChangeSelection = { serverIds: ids, versions, ...(binding ? { binding } : {}) }
  const id = randomUUID()
  await transaction(db, async (c) => {
    const servers = (
      await c.query<{
        id: string
        config_revision: string
        environment_revision: string
        name: string
        host: string
        declared_os: ServerSecret['declared_os']
      }>(
        'select s.id,s.name,s.host,s.config_revision,s.declared_os,r.environment_revision from servers s join server_runtime r on r.server_id=s.id where s.id=any($1::uuid[]) order by s.id for update of s',
        [ids],
      )
    ).rows
    if (servers.length !== ids.length) throw new ServerError('server_not_found')
    if (binding) {
      const lease = await definitions.lease(binding.groupId, binding.typeKey, servers[0]!.declared_os)
      if (!lease) throw new ServerError('type_unavailable')
      try {
        restrictLease(lease, binding.policies)
      } finally {
        lease.release()
      }
    }
    await c.query(
      "insert into server_change_plans(id,kind,state,request_snapshot) values($1,$2,'draft',$3)",
      [id, kind, JSON.stringify({ selection })],
    )
    for (const s of servers) {
      const target = randomUUID(),
        job = randomUUID()
      await c.query(
        `insert into server_change_targets(id,plan_id,server_id,server_identity,server_snapshot,expected_config_revision,expected_environment_revision,definition_revision,target_snapshot,preflight_state)
    values($1,$2,$3,$3,$4,$5,$6,'','{}','queued')`,
        [
          target,
          id,
          s.id,
          JSON.stringify({ id: s.id, name: s.name, host: s.host }),
          s.config_revision,
          s.environment_revision,
        ],
      )
      await c.query(
        `insert into server_jobs(id,server_id,server_identity,target_id,purpose,expected_config_revision,expected_environment_revision,definition_revision,idempotency_key,operation_id,request_snapshot)
    values($1,$2,$2,$3,'inspect',$4,$5,'',$1::uuid::text,$6,$7)`,
        [
          job,
          s.id,
          target,
          s.config_revision,
          s.environment_revision,
          randomUUID(),
          JSON.stringify({ action: 'preflight_' + kind, planId: id }),
        ],
      )
    }
  })
  return id
}
export async function preflightRequest(db: Db, job: JobRecord): Promise<ChangeRequest> {
  const row = (
    await db.query<PlanRow>(
      `select p.* from server_change_plans p join server_change_targets t on t.plan_id=p.id where t.id=$1 and p.state='draft'`,
      [job.target_id],
    )
  ).rows[0]
  if (!row) throw new ServerError('plan_not_ready')
  return row.request_snapshot
}
export async function savePreflight(
  db: Db,
  job: JobRecord,
  server: ServerSecret,
  plan: PreparedPlan,
): Promise<void> {
  const target = (
    await db.query<{ plan_id: string }>('select plan_id from server_change_targets where id=$1', [
      job.target_id,
    ])
  ).rows[0]
  if (!target) throw new ServerError('plan_not_ready')
  const parent = (
    await db.query<PlanRow>('select * from server_change_plans where id=$1 for update', [target.plan_id])
  ).rows[0]!
  if (parent.state !== 'draft') throw new ServerError('plan_not_ready')
  await db.query(
    `update server_change_targets set preflight_state='ready',target_snapshot=$2,definition_revision=$3,expected_environment_revision=$4 where id=$1`,
    [job.target_id, JSON.stringify(plan), plan.definitionRevision, server.environment_revision],
  )
}
/** Invoked in the fenced completion transaction, so a late preflight worker cannot overwrite cancellation. */
export async function finishPreflight(db: Db, job: JobRecord, state: string, result: unknown): Promise<void> {
  const target = (
    await db.query<{ plan_id: string }>('select plan_id from server_change_targets where id=$1', [
      job.target_id,
    ])
  ).rows[0]
  if (!target) return
  const parent = (
    await db.query<PlanRow>('select * from server_change_plans where id=$1 for update', [target.plan_id])
  ).rows[0]!
  if (parent.state !== 'draft') return
  if (state !== 'succeeded')
    await db.query(
      "update server_change_targets set preflight_state='failed',preflight_error=$2 where id=$1",
      [job.target_id, JSON.stringify(result)],
    )
  const targets = (
    await db.query<{ preflight_state: string }>(
      'select preflight_state from server_change_targets where plan_id=$1',
      [parent.id],
    )
  ).rows
  if (targets.some((t) => t.preflight_state === 'queued')) return
  await db.query('update server_change_plans set state=$2,revision=revision+1,updated_at=now() where id=$1', [
    parent.id,
    targets.some((t) => t.preflight_state === 'failed') ? 'blocked' : 'awaiting_confirmation',
  ])
}
async function targetRows(db: Db, id: string) {
  return (
    await db.query<{
      id: string
      server_id: string
      server_snapshot: unknown
      expected_config_revision: string
      expected_environment_revision: string
      definition_revision: string
      target_snapshot: PreparedPlan
      state: string
      preflight_state: string
      preflight_error: unknown
      result: unknown
    }>('select * from server_change_targets where plan_id=$1 order by server_identity', [id])
  ).rows
}
function frozenTargets(targets: Awaited<ReturnType<typeof targetRows>>) {
  return targets.map((t) => ({
    id: t.id,
    serverId: t.server_id,
    configRevision: String(t.expected_config_revision),
    environmentRevision: String(t.expected_environment_revision),
    definitionRevision: t.definition_revision,
    plan: t.target_snapshot,
  }))
}
export async function readChangePlan(db: Db, id: string) {
  const plan = (await db.query<PlanRow>('select * from server_change_plans where id=$1', [id])).rows[0]
  if (!plan) throw new HttpError(404, 'plan_not_ready')
  const targets = await targetRows(db, id)
  return {
    ...plan,
    targets,
    review_digest: digest({ selection: plan.request_snapshot.selection, targets: frozenTargets(targets) }),
  }
}
export async function confirmChangePlan(db: Db, id: string, input: Record<string, unknown>): Promise<void> {
  await transaction(db, async (c) => {
    const plan = (await c.query<PlanRow>('select * from server_change_plans where id=$1 for update', [id]))
      .rows[0]
    if (!plan || plan.state !== 'awaiting_confirmation' || String(input.revision) !== String(plan.revision))
      throw new ServerError('plan_not_ready')
    const targets = await targetRows(c, id),
      frozen = frozenTargets(targets)
    if (
      input.review_digest !== digest({ selection: plan.request_snapshot.selection, targets: frozen }) ||
      targets.some((t) => t.preflight_state !== 'ready')
    )
      throw new ServerError('plan_not_ready')
    const start = new Date(String(input.start)),
      end = new Date(String(input.end)),
      timezone = String(input.timezone),
      concurrency = Number(input.concurrency)
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
    } catch (cause) {
      throw new ServerError('upgrade_invalid', {}, { cause })
    }
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end.getTime() <= Date.now() ||
      end <= start ||
      end.getTime() - start.getTime() > 7 * 86400000 ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4
    )
      throw new ServerError('upgrade_invalid')
    const changes = targets.flatMap((t) => t.target_snapshot.changes),
      mutations = changes.filter((ch) => ['install', 'upgrade', 'replace'].includes(ch.action))
    if (
      (mutations.some((ch) => ch.action === 'replace') && input.ack_replacement !== true) ||
      (targets.some((t) => t.target_snapshot.risks?.major) && input.ack_major !== true) ||
      (mutations.some((ch) => ch.effects.length) && input.ack_service_impact !== true)
    )
      throw new ServerError('plan_ack_required')
    for (const t of targets) {
      const current = (
        await c.query<{ config_revision: string; environment_revision: string }>(
          'select s.config_revision,r.environment_revision from servers s join server_runtime r on r.server_id=s.id where s.id=$1',
          [t.server_id],
        )
      ).rows[0]
      if (
        !current ||
        String(current.config_revision) !== String(t.expected_config_revision) ||
        String(current.environment_revision) !== String(t.expected_environment_revision)
      )
        throw new ServerError('job_configuration_changed')
    }
    const request: ChangeRequest = {
      ...plan.request_snapshot,
      targets: frozen,
      execution: { start: start.toISOString(), end: end.toISOString(), timezone, concurrency },
      acknowledgments: {
        replacement: input.ack_replacement === true,
        major: input.ack_major === true,
        serviceImpact: input.ack_service_impact === true,
      },
    }
    const fingerprint = digest(request)
    await c.query(
      `update server_change_plans set state='scheduled',revision=revision+1,request_snapshot=$2,confirmation_digest=$3,confirmed_by='authenticated-console-user',confirmed_at=now(),authorization_kind='explicit',window_start=$4,window_end=$5,timezone=$6,concurrency=$7,updated_at=now() where id=$1`,
      [id, JSON.stringify(request), fingerprint, start, end, timezone, concurrency],
    )
    for (const t of targets) {
      const jobId = randomUUID()
      await c.query(
        `insert into server_jobs(id,server_id,server_identity,target_id,purpose,expected_config_revision,expected_environment_revision,definition_revision,idempotency_key,operation_id,request_snapshot)
    values($1,$2,$2,$3,'apply_plan',$4,$5,$6,$1::uuid::text,$7,$8)`,
        [
          jobId,
          t.server_id,
          t.id,
          t.expected_config_revision,
          t.expected_environment_revision,
          t.definition_revision,
          randomUUID(),
          JSON.stringify({
            action: plan.kind === 'move' ? 'move_server' : 'upgrade_software',
            planId: id,
            digest: fingerprint,
          }),
        ],
      )
    }
  })
}
export async function controlPlan(db: Db, id: string, action: 'pause' | 'cancel'): Promise<void> {
  await transaction(db, async (c) => {
    const p = (await c.query<PlanRow>('select * from server_change_plans where id=$1 for update', [id]))
      .rows[0]
    if (
      !p ||
      ![
        'draft',
        'awaiting_confirmation',
        'scheduled',
        'running',
        'paused',
        'blocked',
        'partial_failure',
      ].includes(p.state)
    )
      throw new ServerError('plan_not_ready')
    await c.query(
      'update server_change_plans set state=$2,revision=revision+1,updated_at=now() where id=$1',
      [id, action === 'pause' ? 'paused' : 'cancelled'],
    )
    if (action === 'cancel') {
      await c.query(
        "update server_jobs j set state='cancelled',phase='finished',finished_at=now() from server_change_targets t where j.target_id=t.id and t.plan_id=$1 and j.state='queued'",
        [id],
      )
      await c.query(
        "update server_change_targets set state='cancelled',finished_at=now() where plan_id=$1 and state='pending'",
        [id],
      )
    }
  })
}
export async function commitBinding(db: Db, job: JobRecord, type: ServerTypeView | undefined): Promise<void> {
  if (!job.target_id) return
  const p = (
    await db.query<PlanRow>(
      'select p.* from server_change_plans p join server_change_targets t on t.plan_id=p.id where t.id=$1',
      [job.target_id],
    )
  ).rows[0]
  const b = p?.request_snapshot.selection?.binding
  if (!b) return
  if (!type) throw new ServerError('type_unavailable')
  const result = await db.query(
    `update servers set group_id=$2,type_key=$3,type_snapshot=$4,type_revision=$5,install_required_software=$6,config_revision=config_revision+1,updated_at=now() where id=$1 and config_revision=$7 returning id`,
    [
      job.server_id,
      b.groupId,
      b.typeKey,
      JSON.stringify(type),
      job.definition_revision,
      b.installMissing,
      job.expected_config_revision,
    ],
  )
  if (!result.rows.length) throw new ServerError('job_configuration_changed')
  await writePolicies(
    db,
    job.server_id,
    type.software.map(
      (s) =>
        b.policies.find((p) => p.software_key === s.software_key) ?? {
          software_key: s.software_key,
          restriction: { kind: 'any' },
          detect_updates: false,
        },
    ),
  )
  await db.query(
    "update server_upgrade_suggestions set validity='obsolete' where server_id=$1 and validity in ('eligible','blocked')",
    [job.server_id],
  )
  // These observations were verified against the target definition; mark only that closure with the committed revision.
  await db.query(
    `update server_software_observations set observed_config_revision=observed_config_revision+1 where server_id=$1 and software_key=any($2::text[]) and observed_config_revision=$3`,
    [job.server_id, type.software.map((s) => s.software_key), job.expected_config_revision],
  )
  await db.query(
    'update server_runtime set observed_config_revision=observed_config_revision+1 where server_id=$1 and observed_config_revision=$2',
    [job.server_id, job.expected_config_revision],
  )
}
