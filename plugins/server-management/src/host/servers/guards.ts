import { type Db } from '../db.ts'
import { HttpError } from '../errors.ts'
import * as servers from '../servers/repository.ts'

export async function notRunning(db: Db, id: string): Promise<void> {
  if ((await servers.activeJobs(db, id)).rows.length > 0) throw new HttpError(409, 'server_busy')
}
