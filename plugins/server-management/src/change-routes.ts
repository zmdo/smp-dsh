import { readPolicies, restrictLease } from './policies.ts'
import { ServerError } from './i18n.ts'
import type { DeclaredOs, DetectedOs } from './operating-systems.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Deps } from './records.ts'
import { readJson, sendJson } from './reply.ts'
import { HttpError } from './store.ts'
import { createChangePlan, readChangePlan, confirmChangePlan, controlPlan, transaction } from './changes.ts'
import { queueDetection } from './upgrades.ts'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(422, 'upgrade_invalid')
  return value as Record<string, unknown>
}
const uuid = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i
export async function routeChanges(
  deps: Deps,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
): Promise<void> {
  const db = deps.db,
    parts = rest.split('/').filter(Boolean),
    params = new URL(req.url ?? '/', 'http://localhost').searchParams
  if (parts[0] === 'inventory' && req.method === 'GET')
    return sendJson(
      res,
      200,
      (
        await db.query(
          `select id,name,group_id,type_key,type_snapshot->'name_i18n' as type_name_i18n,type_snapshot->'software' as required_software from servers order by name,id`,
        )
      ).rows,
    )
  if (parts[0] === 'plans' && parts.length === 1) {
    if (req.method === 'GET') {
      const rows = (
        await db.query(`select p.*, (select count(*)::int from server_change_targets t where t.plan_id=p.id) as target_count,
    (select count(*)::int from server_change_targets t where t.plan_id=p.id and t.state='succeeded') as succeeded_count, (select count(*)::int from server_change_targets t where t.plan_id=p.id and t.state='running') as running_count from server_change_plans p where p.kind in ('upgrade','move') order by p.created_at desc limit 200`)
      ).rows
      return sendJson(res, 200, rows)
    }
    if (req.method === 'POST')
      return sendJson(res, 202, { id: await createChangePlan(db, deps.definitions, await readJson(req)) })
  }
  if (parts[0] === 'plans' && uuid.test(parts[1] ?? '')) {
    const id = parts[1]!
    if (parts.length === 2 && req.method === 'GET') return sendJson(res, 200, await readChangePlan(db, id))
    if (parts.length === 3 && req.method === 'POST') {
      const action = parts[2]
      if (action === 'confirm') await confirmChangePlan(db, id, object(await readJson(req)))
      else if (action === 'pause' || action === 'cancel') await controlPlan(db, id, action)
      else if (action === 'retry') {
        const old = await readChangePlan(db, id)
        if (!['paused', 'blocked', 'partial_failure', 'missed', 'cancelled'].includes(old.state))
          throw new HttpError(409, 'plan_not_ready')
        if (old.targets.some((t) => t.state === 'running')) throw new HttpError(409, 'server_busy')
        const selection = old.request_snapshot.selection,
          ids = old.targets.filter((t) => t.state !== 'succeeded').map((t) => t.server_id)
        if (!ids.length) throw new HttpError(422, 'plan_not_ready')
        const b = selection.binding
        return sendJson(res, 202, {
          id: await createChangePlan(db, deps.definitions, {
            kind: old.kind,
            server_ids: ids,
            versions: selection.versions,
            ...(b
              ? {
                  group_id: b.groupId,
                  type_key: b.typeKey,
                  install_missing: b.installMissing,
                  software_policies: b.policies,
                }
              : {}),
          }),
        })
      } else throw new HttpError(404, 'plan_not_ready')
      return sendJson(res, 200, await readChangePlan(db, id))
    }
  }
  if (parts[0] === 'detect' && req.method === 'POST') {
    const input = object(await readJson(req))
    if (
      !Array.isArray(input.server_ids) ||
      !input.server_ids.length ||
      input.server_ids.length > 500 ||
      input.server_ids.some((id) => typeof id !== 'string' || !uuid.test(id))
    )
      throw new HttpError(422, 'upgrade_invalid')
    await queueDetection(db, input.server_ids, false, deps.updateCheckIntervalSeconds)
    return sendJson(res, 202, { queued: input.server_ids.length })
  }
  if (
    parts[0] === 'suggestions' &&
    parts.length === 3 &&
    uuid.test(parts[1] ?? '') &&
    req.method === 'POST'
  ) {
    const id = parts[1]!,
      action = parts[2],
      input = object(await readJson(req))
    await transaction(db, async (c) => {
      const suggestion = (
        await c.query<{ server_id: string; software_key: string }>(
          'select server_id,software_key from server_upgrade_suggestions where id=$1 for update',
          [id],
        )
      ).rows[0]
      if (!suggestion) throw new HttpError(404, 'upgrade_invalid')
      if (action === 'reject' || action === 'restore')
        await c.query(
          "update server_upgrade_suggestions set decision=$2,decision_at=case when $2='rejected' then now() else null end where id=$1",
          [id, action === 'reject' ? 'rejected' : 'none'],
        )
      else if (action === 'defer') {
        const until = input.until === null ? null : new Date(String(input.until))
        if (until && (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()))
          throw new HttpError(422, 'upgrade_invalid')
        await c.query(
          'update server_software_policies set reminder_after=$3 where server_id=$1 and software_key=$2',
          [suggestion.server_id, suggestion.software_key, until],
        )
      } else throw new HttpError(422, 'upgrade_invalid')
    })
    return sendJson(res, 200, { ok: true })
  }
  if (parts[0] === 'suggestions' && req.method === 'GET') {
    const page = Math.max(1, Number(params.get('page') ?? 1)),
      pageSize = 20
    if (!Number.isSafeInteger(page)) throw new HttpError(422, 'upgrade_invalid')
    const rows = (
      await db.query(`select u.*,s.name as server_name,s.host,s.group_id,s.type_key,r.connection_state,p.reminder_after,
   p.check_error,p.last_check_at,(select g.name from server_groups g where g.id=s.group_id) as group_name,
   exists(select 1 from server_change_targets t join server_change_plans cp on cp.id=t.plan_id where t.server_id=s.id and cp.state in ('scheduled','running') and cp.kind='upgrade') as scheduled
   from server_upgrade_suggestions u join servers s on s.id=u.server_id join server_runtime r on r.server_id=s.id
   left join server_software_policies p on p.server_id=u.server_id and p.software_key=u.software_key
   where u.validity in ('eligible','blocked') and u.basis_snapshot->>'configRevision'=s.config_revision::text and u.basis_snapshot->>'environmentRevision'=r.environment_revision::text order by s.name,u.software_key,u.product_version`)
    ).rows
    const query = (params.get('q') ?? '').toLowerCase(),
      state = params.get('decision') ?? '',
      group = params.get('group_id'),
      type = params.get('type_key'),
      software = params.get('software'),
      connection = params.get('connection'),
      current = params.get('current'),
      target = params.get('target')
    const signatures = await currentSignatures(deps, [...new Set(rows.map((r) => String(r.server_id)))])
    for (const row of rows)
      if (
        signatures.get(String(row.server_id)) !==
        (row.basis_snapshot as { definitionRevision: string }).definitionRevision
      ) {
        row.validity = 'blocked'
        row.reason = { ...(row.reason as object), code: 'job_definition_changed' }
      }
    const server = params.get('server_id')
    const filtered = rows.filter((r) => {
      const deferred = r.reminder_after && new Date(String(r.reminder_after)).getTime() > Date.now()
      return (
        (!server || r.server_id === server) &&
        (!query ||
          [r.server_name, r.host, r.software_key].some((v) => String(v).toLowerCase().includes(query))) &&
        (!group || r.group_id === group) &&
        (!type || r.type_key === type) &&
        (!software || r.software_key === software) &&
        (!connection || r.connection_state === connection) &&
        (!current ||
          String((r.basis_snapshot as { before: { version?: string } }).before.version ?? '').includes(
            current,
          )) &&
        (!target || String(r.product_version).includes(target)) &&
        (!state ||
          state === 'all' ||
          (state === 'pending' && r.decision === 'none' && !deferred && !r.scheduled) ||
          (state === 'deferred' && deferred) ||
          (state === 'rejected' && r.decision === 'rejected') ||
          (state === 'scheduled' && r.scheduled))
      )
    })
    const checks = (
      await db.query(
        `select p.server_id,p.software_key,p.last_check_at,p.check_error,p.check_snapshot,s.name as server_name,s.host,s.group_id,s.type_key,r.connection_state from server_software_policies p join servers s on s.id=p.server_id join server_runtime r on r.server_id=s.id where p.last_check_at is not null order by p.last_check_at desc limit 200`,
      )
    ).rows
    return sendJson(res, 200, {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      page_size: pageSize,
      filtered_server_ids: [...new Set(filtered.map((r) => r.server_id))],
      checks: checks.filter(
        (r) =>
          (!server || r.server_id === server) &&
          (!group || r.group_id === group) &&
          (!type || r.type_key === type) &&
          (!software || r.software_key === software) &&
          (!connection || r.connection_state === connection) &&
          (!query ||
            [r.server_name, r.host, r.software_key].some((v) => String(v).toLowerCase().includes(query))),
      ),
    })
  }
  if (parts[0] === 'versions' && req.method === 'POST') {
    const input = object(await readJson(req)),
      ids = input.server_ids,
      software = input.software
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 500 ||
      ids.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
      typeof software !== 'string'
    )
      throw new HttpError(422, 'upgrade_invalid')
    const rows = (
      await db.query<{
        server_id: string
        check_snapshot: {
          eligible: { version: string }[]
          basis: { configRevision: string; environmentRevision: string; definitionRevision: string }
        } | null
        config_revision: string
        environment_revision: string
      }>(
        `select p.server_id,p.check_snapshot,s.config_revision,r.environment_revision from server_software_policies p join servers s on s.id=p.server_id join server_runtime r on r.server_id=s.id where p.server_id=any($1::uuid[]) and p.software_key=$2`,
        [ids, software],
      )
    ).rows
    const signatures = await currentSignatures(deps, ids)
    const blockers = ids.filter(
      (id) =>
        !rows.some(
          (r) =>
            r.server_id === id &&
            r.check_snapshot &&
            r.check_snapshot.basis.configRevision === String(r.config_revision) &&
            r.check_snapshot.basis.environmentRevision === String(r.environment_revision) &&
            r.check_snapshot.basis.definitionRevision === signatures.get(r.server_id),
        ),
    )
    const versions = blockers.length
      ? []
      : [...new Set(rows[0]!.check_snapshot!.eligible.map((c) => c.version))].filter((v) =>
          rows.every((r) => r.check_snapshot!.eligible.some((c) => c.version === v)),
        )
    return sendJson(res, 200, { versions, blockers })
  }
  if (parts[0] === 'records' && req.method === 'GET') {
    const page = Math.max(1, Number(params.get('page') ?? 1))
    if (!Number.isSafeInteger(page)) throw new HttpError(422, 'upgrade_invalid')
    const rows = (
      await db.query(
        `select j.id,j.server_identity,j.state,j.phase,j.request_snapshot,j.result,j.output_excerpt,j.created_at,j.finished_at,t.server_snapshot,t.plan_id,
   coalesce((select jsonb_agg(st order by st.ordinal) from server_job_steps st where st.job_id=j.id),'[]'::jsonb) as steps
   from server_jobs j join server_change_targets t on t.id=j.target_id join server_change_plans p on p.id=t.plan_id
   where j.purpose='apply_plan' and p.kind in ('upgrade','move') order by j.created_at desc limit 20 offset $1`,
        [(page - 1) * 20],
      )
    ).rows
    const total = (
      await db.query<{ count: string }>(
        "select count(*) from server_jobs j join server_change_targets t on t.id=j.target_id join server_change_plans p on p.id=t.plan_id where j.purpose='apply_plan' and p.kind in ('upgrade','move')",
      )
    ).rows[0]!.count
    return sendJson(res, 200, { items: rows, total: Number(total), page, page_size: 20 })
  }
  throw new HttpError(404, 'plan_not_ready')
}

async function currentSignatures(deps: Deps, ids: string[]): Promise<Map<string, string>> {
  const servers = (
    await deps.db.query<{
      id: string
      group_id: string | null
      type_key: string
      declared_os: DeclaredOs
      detected_os: DetectedOs | null
    }>(
      `select s.id,s.group_id,s.type_key,s.declared_os,r.detected_os from servers s join server_runtime r on r.server_id=s.id where s.id=any($1::uuid[])`,
      [ids],
    )
  ).rows
  const signatures = new Map<string, string>()
  for (const server of servers) {
    const lease = await deps.definitions.lease(
      server.group_id,
      server.type_key,
      server.detected_os ?? server.declared_os,
    )
    if (!lease) continue
    try {
      signatures.set(server.id, restrictLease(lease, await readPolicies(deps.db, server.id)).signature)
    } catch (cause) {
      if (!(cause instanceof ServerError)) throw cause
    } finally {
      lease.release()
    }
  }
  return signatures
}
