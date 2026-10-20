import { type JobRecord } from '../../job-store.ts'
import { type Db } from '../db.ts'

export function readJob(db: Db, id: string) {
  return db.query<JobRecord>('select * from server_jobs where id = $1', [id])
}
