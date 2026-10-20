import { type PreparedPlan } from '../../shared/changes.ts'
import type { DeclaredOs } from '../../shared/operating-system-types.ts'
import { type Db } from '../db.ts'
import { type PlanRow } from './model.ts'

export function listPlans(db: Db) {
  return db.query(`select p.*, (select count(*)::int from server_change_targets t where t.plan_id=p.id) as target_count,
    (select count(*)::int from server_change_targets t where t.plan_id=p.id and t.state='succeeded') as succeeded_count, (select count(*)::int from server_change_targets t where t.plan_id=p.id and t.state='running') as running_count from server_change_plans p where p.kind in ('upgrade','move') order by p.created_at desc limit 200`)
}

export function lockServers(db: Db, ids: string[]) {
  return db.query<{
    id: string
    config_revision: string
    environment_revision: string
    name: string
    host: string
    declared_os: DeclaredOs
  }>(
    'select s.id,s.name,s.host,s.config_revision,s.declared_os,r.environment_revision from servers s join server_runtime r on r.server_id=s.id where s.id=any($1::uuid[]) order by s.id for update of s',
    [ids],
  )
}

export function insertPlan(db: Db, { id, kind, snapshot }: { id: string; kind: string; snapshot: string }) {
  return db.query(
    "insert into server_change_plans(id,kind,state,request_snapshot) values($1,$2,'draft',$3)",
    [id, kind, snapshot],
  )
}

export function insertTarget(
  db: Db,
  {
    id,
    planId,
    serverId,
    snapshot,
    configRevision,
    environmentRevision,
  }: {
    id: string
    planId: string
    serverId: string
    snapshot: string
    configRevision: string
    environmentRevision: string
  },
) {
  return db.query(
    `insert into server_change_targets(id,plan_id,server_id,server_identity,server_snapshot,expected_config_revision,expected_environment_revision,definition_revision,target_snapshot,preflight_state)
    values($1,$2,$3,$3,$4,$5,$6,'','{}','queued')`,
    [id, planId, serverId, snapshot, configRevision, environmentRevision],
  )
}

export function insertPreflightJob(
  db: Db,
  {
    id,
    serverId,
    targetId,
    configRevision,
    environmentRevision,
    operationId,
    snapshot,
  }: {
    id: string
    serverId: string
    targetId: string | null
    configRevision: string
    environmentRevision: string
    operationId: string
    snapshot: string
  },
) {
  return db.query(
    `insert into server_jobs(id,server_id,server_identity,target_id,purpose,expected_config_revision,expected_environment_revision,definition_revision,idempotency_key,operation_id,request_snapshot)
    values($1,$2,$2,$3,'inspect',$4,$5,'',$1::uuid::text,$6,$7)`,
    [id, serverId, targetId, configRevision, environmentRevision, operationId, snapshot],
  )
}

export function draftForTarget(db: Db, targetId: string | null) {
  return db.query<PlanRow>(
    `select p.* from server_change_plans p join server_change_targets t on t.plan_id=p.id where t.id=$1 and p.state='draft'`,
    [targetId],
  )
}

export function targetParent(db: Db, targetId: string | null) {
  return db.query<{ plan_id: string }>('select plan_id from server_change_targets where id=$1', [targetId])
}

export function lockPlan(db: Db, id: string) {
  return db.query<PlanRow>('select * from server_change_plans where id=$1 for update', [id])
}

export function readyPreflight(
  db: Db,
  {
    targetId,
    snapshot,
    definitionRevision,
    environmentRevision,
  }: {
    targetId: string | null
    snapshot: string
    definitionRevision: string
    environmentRevision: string | number
  },
) {
  return db.query(
    `update server_change_targets set preflight_state='ready',target_snapshot=$2,definition_revision=$3,expected_environment_revision=$4 where id=$1`,
    [targetId, snapshot, definitionRevision, environmentRevision],
  )
}

export function failPreflight(db: Db, targetId: string | null, result: string) {
  return db.query(
    "update server_change_targets set preflight_state='failed',preflight_error=$2 where id=$1",
    [targetId, result],
  )
}

export function preflightStates(db: Db, id: string) {
  return db.query<{ preflight_state: string }>(
    'select preflight_state from server_change_targets where plan_id=$1',
    [id],
  )
}

export function setPlanState(db: Db, id: string, state: string) {
  return db.query(
    'update server_change_plans set state=$2,revision=revision+1,updated_at=now() where id=$1',
    [id, state],
  )
}

export function targetRows(db: Db, id: string) {
  return db.query<{
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
}

export function readPlan(db: Db, id: string) {
  return db.query<PlanRow>('select * from server_change_plans where id=$1', [id])
}

export function serverRevisions(db: Db, id: string) {
  return db.query<{ config_revision: string; environment_revision: string }>(
    'select s.config_revision,r.environment_revision from servers s join server_runtime r on r.server_id=s.id where s.id=$1',
    [id],
  )
}

export function schedulePlan(
  db: Db,
  {
    id,
    snapshot,
    fingerprint,
    start,
    end,
    timezone,
    concurrency,
  }: {
    id: string
    snapshot: string
    fingerprint: string
    start: Date
    end: Date
    timezone: string
    concurrency: number
  },
) {
  return db.query(
    `update server_change_plans set state='scheduled',revision=revision+1,request_snapshot=$2,confirmation_digest=$3,confirmed_by='authenticated-console-user',confirmed_at=now(),authorization_kind='explicit',window_start=$4,window_end=$5,timezone=$6,concurrency=$7,updated_at=now() where id=$1`,
    [id, snapshot, fingerprint, start, end, timezone, concurrency],
  )
}

export function insertApplyJob(
  db: Db,
  {
    id,
    serverId,
    targetId,
    configRevision,
    environmentRevision,
    definitionRevision,
    operationId,
    snapshot,
  }: {
    id: string
    serverId: string
    targetId: string | null
    configRevision: string
    environmentRevision: string
    definitionRevision: string
    operationId: string
    snapshot: string
  },
) {
  return db.query(
    `insert into server_jobs(id,server_id,server_identity,target_id,purpose,expected_config_revision,expected_environment_revision,definition_revision,idempotency_key,operation_id,request_snapshot)
    values($1,$2,$2,$3,'apply_plan',$4,$5,$6,$1::uuid::text,$7,$8)`,
    [id, serverId, targetId, configRevision, environmentRevision, definitionRevision, operationId, snapshot],
  )
}

export function cancelQueuedJobs(db: Db, id: string) {
  return db.query(
    "update server_jobs j set state='cancelled',phase='finished',finished_at=now() from server_change_targets t where j.target_id=t.id and t.plan_id=$1 and j.state='queued'",
    [id],
  )
}

export function cancelPendingTargets(db: Db, id: string) {
  return db.query(
    "update server_change_targets set state='cancelled',finished_at=now() where plan_id=$1 and state='pending'",
    [id],
  )
}

export function planForTarget(db: Db, targetId: string | null) {
  return db.query<PlanRow>(
    'select p.* from server_change_plans p join server_change_targets t on t.plan_id=p.id where t.id=$1',
    [targetId],
  )
}

export function commitBinding(
  db: Db,
  {
    id,
    groupId,
    typeKey,
    snapshot,
    definitionRevision,
    installMissing,
    configRevision,
  }: {
    id: string
    groupId: string | null
    typeKey: string
    snapshot: string
    definitionRevision: string
    installMissing: boolean
    configRevision: string | number | null
  },
) {
  return db.query(
    `update servers set group_id=$2,type_key=$3,type_snapshot=$4,type_revision=$5,install_required_software=$6,config_revision=config_revision+1,updated_at=now() where id=$1 and config_revision=$7 returning id`,
    [id, groupId, typeKey, snapshot, definitionRevision, installMissing, configRevision],
  )
}

export function advanceSoftwareRevision(
  db: Db,
  {
    id,
    softwareKeys,
    configRevision,
  }: { id: string; softwareKeys: string[]; configRevision: string | number | null },
) {
  return db.query(
    `update server_software_observations set observed_config_revision=observed_config_revision+1 where server_id=$1 and software_key=any($2::text[]) and observed_config_revision=$3`,
    [id, softwareKeys, configRevision],
  )
}

export function advanceRuntimeRevision(db: Db, id: string, configRevision: string | number | null) {
  return db.query(
    'update server_runtime set observed_config_revision=observed_config_revision+1 where server_id=$1 and observed_config_revision=$2',
    [id, configRevision],
  )
}
