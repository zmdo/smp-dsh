import type { ChangeRequest } from '../../shared/changes.ts'
import type { Db } from '../db.ts'
import type { TypeLease } from '../definitions/model.ts'
import type { OsProbe } from '../remote/os-probe.ts'
import type { SshSession } from '../remote/ssh.ts'
import type { ServerSecret } from '../servers/model.ts'
import type { JobRecord } from './model.ts'

export interface WorkerContext {
  db: Db
  job: JobRecord
  session: SshSession
  server: ServerSecret
  lease: TypeLease | undefined
  probe: OsProbe
  verified: string
  explicit?: ChangeRequest
  secret: string
  guard(): Promise<void>
  state: { mutation: boolean }
  updateCheckIntervalSeconds: number
}
