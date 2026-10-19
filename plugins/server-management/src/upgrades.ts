import { randomUUID } from 'node:crypto'
import { saveComponentStatus } from './store.ts'
import type { Db, JobRecord, ServerSecret } from './store.ts'
import type { TypeLease } from './registry.ts'
import type { DetectedOs } from './operating-systems.ts'
import type { SshSession } from './ssh.ts'
import { candidatesFor, environment, observe } from './plans.ts'
import { canonical, invokeRecipe } from './recipe.ts'
import { detectionEligibility } from './policies.ts'
import { ServerError, errorPayload } from './i18n.ts'
import { owned } from './job-store.ts'
import { enqueue } from './job-store.ts'
import { transaction } from './changes.ts'
import type { Candidate, SoftwareObservation } from './contracts.ts'

export interface UpdateCheck {
  software: string
  before: SoftwareObservation
  eligible: Candidate[]
  reason: string | null
  errors: unknown[]
}
/** Read-only candidate resolution. Neither a detection preference nor a due reminder authorizes execute. */
export async function detectUpdates(
  session: SshSession,
  lease: TypeLease,
  os: DetectedOs,
  selected?: readonly string[],
): Promise<UpdateCheck[]> {
  const checks: UpdateCheck[] = []
  for (const c of lease.components) {
    if (selected && !selected.includes(c.software_key)) continue
    const before = await observe(session, c, os),
      check: UpdateCheck = { software: c.software_key, before, eligible: [], reason: null, errors: [] }
    checks.push(check)
    if (before.state === 'unknown') {
      check.reason = 'detection_failed'
      continue
    }
    if (before.state === 'missing') {
      check.reason = 'not_installed'
      continue
    }
    if (!before.healthy) {
      check.reason = 'unhealthy'
      continue
    }
    if (!c.adapter.contains(c.versions, before.version)) {
      check.reason = 'version_conflict'
      continue
    }
    check.reason = detectionEligibility(c, before.version)
    if (check.reason) continue
    if (!c.actions.includes('upgrade') || !c.scripts.resolve) {
      check.reason = 'recipe_unavailable'
      continue
    }
    try {
      const candidates = await candidatesFor(session, c, os, before)
      for (const candidate of candidates.filter((v) => c.adapter.compare(v.version, before.version) > 0)) {
        try {
          const resolved = await invokeRecipe(session, c.scripts.resolve, {
            ...environment(c, os),
            operation: 'resolve',
            action: 'upgrade',
            installed: before,
            target: candidate,
          })
          if (
            resolved.operation !== 'resolve' ||
            resolved.change.action !== 'upgrade' ||
            canonical(resolved.change.before) !== canonical(before) ||
            canonical(resolved.change.target) !== canonical(candidate) ||
            resolved.change.dependencies.some(
              (key) =>
                !c.requires.some(
                  (id) => lease.components.find((item) => item.id === id)?.software_key === key,
                ),
            )
          )
            throw new ServerError('plan_conflict')
          check.eligible.push(candidate)
        } catch (cause) {
          check.errors.push(
            errorPayload(cause instanceof ServerError ? cause : new ServerError('plan_conflict')),
          )
        }
      }
    } catch (cause) {
      check.reason = 'detection_failed'
      check.errors.push(
        errorPayload(cause instanceof ServerError ? cause : new ServerError('request_failed')),
      )
    }
  }
  return checks
}
export async function saveUpdateChecks(
  db: Db,
  job: JobRecord,
  server: ServerSecret,
  lease: TypeLease,
  checks: UpdateCheck[],
  intervalSeconds: number,
): Promise<void> {
  await owned(db, job, async (c) => {
    for (const check of checks) {
      const component = lease.components.find((item) => item.software_key === check.software)!
      await saveComponentStatus(
        c,
        server.id,
        {
          [component.id]: {
            ...check.before,
            installed: check.before.state === 'installed',
            detail: 'detail' in check.before ? (check.before.detail ?? '') : '',
            revision: component.revision,
          },
        },
        [component],
      )
      const basis = {
        configRevision: String(server.config_revision),
        environmentRevision: String(server.environment_revision),
        definitionRevision: lease.signature,
        versions: component.versions,
        before: check.before,
      }
      await c.query(
        `insert into server_software_policies(server_id,software_key) values($1,$2) on conflict do nothing`,
        [server.id, check.software],
      )
      await c.query(
        `update server_software_policies set last_check_at=now(),next_check_at=case when detect_updates then now()+make_interval(secs=>$3) else null end,
    check_snapshot=$4,check_error=$5 where server_id=$1 and software_key=$2`,
        [
          server.id,
          check.software,
          intervalSeconds,
          JSON.stringify({ ...check, basis }),
          check.reason === 'detection_failed' || check.errors.length
            ? JSON.stringify({ reason: check.reason, errors: check.errors })
            : null,
        ],
      )
      await c.query(
        "update server_upgrade_suggestions set validity='obsolete' where server_id=$1 and software_key=$2 and validity<>'satisfied'",
        [server.id, check.software],
      )
      if (check.before.state !== 'installed') continue
      const from = check.before.version
      // Keep the highest candidate in each major-change path. Rejection cannot cause fallback to an older target.
      const chosen = [
        check.eligible.find((item) => !component.adapter.isMajorChange(from, item.version)),
        check.eligible.find((item) => component.adapter.isMajorChange(from, item.version)),
      ].filter((item): item is Candidate => !!item)
      for (const target of chosen)
        await c.query(
          `insert into server_upgrade_suggestions(id,server_id,software_key,target_identity,product_version,candidate_snapshot,basis_snapshot,validity,reason)
    values($1,$2,$3,$4,$5,$6,$7,'eligible',$8)
    on conflict(server_id,software_key,target_identity) do update set candidate_snapshot=excluded.candidate_snapshot,basis_snapshot=excluded.basis_snapshot,validity='eligible',reason=excluded.reason,last_seen_at=now()`,
          [
            randomUUID(),
            server.id,
            check.software,
            target.targetIdentity,
            target.version,
            JSON.stringify(target),
            JSON.stringify(basis),
            JSON.stringify({ major: component.adapter.isMajorChange(from, target.version) }),
          ],
        )
      await c.query(
        `update server_upgrade_suggestions set validity='satisfied' where server_id=$1 and software_key=$2 and target_identity=$3`,
        [server.id, check.software, check.before.targetIdentity],
      )
    }
  })
}
export async function queueDetection(
  db: Db,
  ids: string[],
  automatic = false,
  intervalSeconds = 3600,
): Promise<void> {
  for (const id of ids)
    await transaction(db, async (c) => {
      const s = (
        await c.query<{ config_revision: string; environment_revision: string }>(
          'select s.config_revision,r.environment_revision from servers s join server_runtime r on r.server_id=s.id where s.id=$1 for update of s',
          [id],
        )
      ).rows[0]
      if (!s) throw new ServerError('server_not_found')
      await c.query(
        `insert into server_software_policies(server_id,software_key) select s.id,item->>'software_key' from servers s cross join lateral jsonb_array_elements(s.type_snapshot->'software') item where s.id=$1 and item->>'software_key' is not null on conflict do nothing`,
        [id],
      )
      if (
        (
          await c.query(
            "select id from server_jobs where server_id=$1 and purpose='detect_updates' and state in ('queued','claimed','running','recovering')",
            [id],
          )
        ).rows.length
      )
        return
      const job = randomUUID()
      await c.query(
        `insert into server_jobs(id,server_id,server_identity,purpose,expected_config_revision,expected_environment_revision,definition_revision,idempotency_key,operation_id,request_snapshot)
   values($1,$2,$2,'detect_updates',$3,$4,'',$1::uuid::text,$5,$6)`,
        [
          job,
          id,
          s.config_revision,
          s.environment_revision,
          randomUUID(),
          JSON.stringify({ action: 'detect_updates', automatic, intervalSeconds }),
        ],
      )
      if (automatic)
        await c.query(
          'update server_software_policies set next_check_at=now()+make_interval(secs=>$2) where server_id=$1 and detect_updates and (next_check_at is null or next_check_at<=now())',
          [id, intervalSeconds],
        )
    })
}
export async function scheduleChanges(db: Db, intervalSeconds = 3600): Promise<void> {
  await transaction(db, async (c) => {
    const expired = (
      await c.query<{ id: string }>(
        "select id from server_change_plans where state in ('scheduled','running') and window_end<now() for update skip locked",
      )
    ).rows
    for (const p of expired) {
      await c.query(
        `update server_jobs j set state='cancelled',phase='finished',finished_at=now(),result='{"summary":"window_missed"}' from server_change_targets t
    where j.target_id=t.id and t.plan_id=$1 and j.state='queued'`,
        [p.id],
      )
      await c.query(
        "update server_change_targets set state='skipped',finished_at=now(),result='{}' where plan_id=$1 and state='pending'",
        [p.id],
      )
      const active = (
        await c.query("select id from server_change_targets where plan_id=$1 and state='running'", [p.id])
      ).rows.length
      if (!active)
        await c.query(
          "update server_change_plans set state=case when exists(select 1 from server_change_targets where plan_id=$1 and state='skipped') then 'missed' else state end where id=$1",
          [p.id],
        )
    }
  })
  const due = (
    await db.query<{ server_id: string }>(
      `select distinct server_id from server_software_policies where detect_updates and (next_check_at is null or next_check_at<=now()) limit 50`,
    )
  ).rows
  await queueDetection(
    db,
    due.map((r) => r.server_id),
    true,
    intervalSeconds,
  )
}
