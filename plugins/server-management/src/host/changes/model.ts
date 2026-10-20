import { type ChangeRequest } from '../../shared/changes.ts'

export interface PlanRow {
  id: string
  kind: 'prepare' | 'move' | 'upgrade'
  state: string
  revision: string
  request_snapshot: ChangeRequest
  confirmation_digest: string | null
  window_start: Date | null
  window_end: Date | null
  concurrency: number
}
