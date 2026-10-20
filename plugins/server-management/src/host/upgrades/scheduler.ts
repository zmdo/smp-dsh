import type { Db } from '../db.ts'
import { transaction } from '../db.ts'
import * as repository from './background-repository.ts'
import { queueDetection } from './detection.ts'

export async function scheduleChanges(db: Db, intervalSeconds = 3600): Promise<void> {
  await transaction(db, async (c) => {
    const expired = (await repository.expiredPlans(c)).rows
    for (const p of expired) {
      await repository.cancelExpiredJobs(c, p.id)
      await repository.skipExpiredTargets(c, p.id)
      const active = (await repository.runningTargets(c, p.id)).rows.length
      if (!active) await repository.markMissed(c, p.id)
    }
  })
  const due = (await repository.dueChecks(db)).rows
  await queueDetection(
    db,
    due.map((r) => r.server_id),
    true,
    intervalSeconds,
  )
}
