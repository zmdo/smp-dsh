import { type Db } from '../db.ts'
import { type JobRecord } from '../execution/model.ts'

export function readJob(db: Db, id: string) {
  return db.query<JobRecord>('select * from server_jobs where id = $1', [id])
}
