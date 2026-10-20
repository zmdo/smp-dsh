import { type Db } from '../db.ts'
import { type JobRecord } from '../execution/model.ts'
import * as history from './history-repository.ts'
import type { TaskQuery } from './query.ts'
import * as tasks from './repository.ts'

export function jobView(row: JobRecord | Record<string, unknown>) {
  return {
    id: row.id,
    action: (row.request_snapshot as { action?: string })?.action ?? row.purpose,
    status: row.state,
    phase: row.phase,
    result: row.result,
    output_excerpt: row.output_excerpt,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }
}
export async function readJob(db: Db, id: string) {
  const row = (await tasks.readJob(db, id)).rows[0]
  return row === undefined ? undefined : jobView(row)
}

export async function taskHistory(db: Db, query: TaskQuery) {
  return history.taskHistory(db, query)
}
