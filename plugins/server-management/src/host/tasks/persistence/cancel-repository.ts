import type { Db } from '../../database/connection.ts'

export function cancelActive(db: Db, id: string) {
  return db.query<{ id: string }>(
    `update server_jobs set state='cancelled',finished_at=now(),output_excerpt='任务已取消。'
     where id=$1 and state in ('queued','claimed','running','recovering') returning id`,
    [id],
  )
}
