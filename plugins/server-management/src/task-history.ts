import { HttpError, type Db } from './store.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTIONS = ['inspect', 'inspection_report', 'test_connection', 'install_components', 'detect_updates', 'preflight_move', 'preflight_upgrade', 'move_server', 'upgrade_software', 'deploy', 'start', 'stop', 'restart', 'logs']
const STATES = ['queued', 'claimed', 'running', 'recovering', 'succeeded', 'failed', 'blocked', 'cancelled']

export interface TaskQuery {
  serverId: string
  query: string
  action: string
  status: string
  from: string | null
  to: string | null
  page: number
  pageSize: number
}

export function parseTaskQuery(params: URLSearchParams): TaskQuery {
  const serverId = params.get('server_id') ?? ''
  const query = (params.get('q') ?? '').trim()
  const action = params.get('action') ?? ''
  const status = params.get('status') ?? ''
  function integer(key: string, fallback: number, maximum: number): number {
    const value = params.get(key)
    if (value === null) return fallback
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum)
      throw new HttpError(422, 'task_query_invalid')
    return Number(value)
  }
  function date(key: string): string | null {
    const value = params.get(key)
    if (!value) return null
    if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw new HttpError(422, 'task_query_invalid')
    return new Date(value).toISOString()
  }
  const from = date('from'), to = date('to')
  if (!UUID.test(serverId) || query.length > 200 || (action && !ACTIONS.includes(action)) || (status && !STATES.includes(status)) || (from && to && from >= to))
    throw new HttpError(422, 'task_query_invalid')
  return { serverId, query, action, status, from, to, page: integer('page', 1, 1_000_000), pageSize: integer('page_size', 10, 100) }
}

export async function taskHistory(db: Db, query: TaskQuery): Promise<unknown> {
  const pattern = query.query ? `%${query.query.replace(/[\\%_]/g, '\\$&')}%` : null
  // One statement gives the count and page a consistent snapshot while tasks finish.
  const result = await db.query(
    `with entries as (
      select id::text,coalesce(request_snapshot->>'action',purpose) as action,state as status,phase,
        result,output_excerpt,created_at,started_at,finished_at
      from server_jobs where server_identity=$1
        and not (purpose='detect_updates' and request_snapshot->>'automatic'='true' and state='succeeded')
        and (not (purpose='inspect' and request_snapshot->>'action'='inspect'
          and request_snapshot->>'prepare' is distinct from 'true') or state in ('failed','blocked'))
      union all
      select 'inspection:'||server_identity||':'||extract(epoch from hour_start)::bigint,
        'inspection_report',case when failed>0 then 'failed' else 'succeeded' end,'finished',
        jsonb_build_object('summary','inspection_report','hour_start',hour_start,'hour_end',hour_start+interval '1 hour',
          'succeeded',succeeded,'failed',failed,'last_checked_at',last_checked_at),
        '',hour_start+interval '1 hour',hour_start,last_checked_at
      from server_inspection_reports where server_identity=$1 and succeeded>0 and hour_start+interval '1 hour'<=now()
    ), filtered as (
      select * from entries where ($2::text is null or concat_ws(' ',id,action,status,output_excerpt,result::text) ilike $2)
        and ($3='' or action=$3) and ($4='' or status=$4)
        and ($5::timestamptz is null or created_at >= $5) and ($6::timestamptz is null or created_at < $6)
    ), bounds as (
      select count(*)::int as total,greatest(1,least($7,ceil(count(*)::numeric/$8)::int)) as page from filtered
    )
    select total,page,$8::int as page_size,coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id desc)
      from (select * from filtered order by created_at desc,id desc limit $8 offset (bounds.page-1)*$8) p),'[]'::jsonb) as items
    from bounds`,
    [query.serverId, pattern, query.action, query.status, query.from, query.to, query.page, query.pageSize],
  )
  return result.rows[0]
}
