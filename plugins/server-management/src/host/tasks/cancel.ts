import type { Db } from '../database/connection.ts'
import { HttpError } from '../errors.ts'
import { cancelActive } from './persistence/cancel-repository.ts'

/** Cancel a queued/running job. A running worker loses its next heartbeat/fence and cannot publish results. */
export async function cancelJob(db: Db, id: string): Promise<void> {
  if ((await cancelActive(db, id)).rows.length === 0) throw new HttpError(409, 'job_not_cancellable')
}
