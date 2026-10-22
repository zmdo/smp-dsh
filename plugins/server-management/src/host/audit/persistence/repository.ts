import type { Db } from '../../database/connection.ts'
import type { AuditRecordRow } from './rows.ts'

export interface AuditListQuery {
  page: number
  pageSize: number
  query: string
  status: string
  since: Date | null
}

export function auditRecords(db: Db, query: AuditListQuery) {
  const offset = (query.page - 1) * query.pageSize
  return db.query<AuditRecordRow>(
    `select * from server_command_audit
     where ($1='' or status=$1)
       and ($2='' or server_name ilike '%' || $2 || '%' or host ilike '%' || $2 || '%'
         or actor_id ilike '%' || $2 || '%' or command ilike '%' || $2 || '%')
       and ($3::timestamptz is null or created_at >= $3)
     order by created_at desc, id desc
     limit $4 offset $5`,
    [query.status, query.query, query.since, query.pageSize, offset],
  )
}

export function auditCount(db: Db, query: AuditListQuery) {
  return db.query<{ count: number }>(
    `select count(*)::int as count from server_command_audit
     where ($1='' or status=$1)
       and ($2='' or server_name ilike '%' || $2 || '%' or host ilike '%' || $2 || '%'
         or actor_id ilike '%' || $2 || '%' or command ilike '%' || $2 || '%')
       and ($3::timestamptz is null or created_at >= $3)`,
    [query.status, query.query, query.since],
  )
}
