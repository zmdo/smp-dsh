import { digest } from '../recipes/canonical.ts'
import { lockCatalog } from '../groups/persistence/catalog-lock.ts'
import { transaction } from '../database/transaction.ts'
import type { Db } from '../database/connection.ts'
import type { AdminContext } from './model.ts'
import { AdminError } from './model.ts'
import { account, audit } from './persistence/repository.ts'
export async function approve(
  db: Db,
  ctx: AdminContext,
  tool: string,
  action: string,
  target: string,
  preview: unknown,
) {
  if (!ctx.agent) throw new AdminError('unauthorized')
  const actor = await account(db)
  const summary = JSON.stringify({ action, target, preview })
  if (summary.length > 48000) throw new AdminError('approval_preview_too_large')
  let outcome = 'unavailable'
  if (ctx.approval && !ctx.signal.aborted) {
    try {
      outcome = await ctx.approval.request({
        agent: ctx.agent,
        toolName: tool,
        callId: ctx.callId,
        reason: summary,
        displayReason: { en: summary, zh: summary },
        signal: ctx.signal,
      })
    } catch (cause) {
      void cause
      outcome = 'unavailable'
    }
  }
  if (outcome !== 'allowed-once' || ctx.signal.aborted) {
    await audit(db, {
      tool,
      action,
      target,
      before: preview,
      status: 'denied',
      actor,
      context: ctx,
      approval: 'denied',
    })
    throw new AdminError('approval_denied')
  }
  return actor
}
export async function mutate<T>(
  db: Db,
  ctx: AdminContext,
  tool: string,
  action: string,
  target: string,
  read: (db: Db, lock: boolean) => Promise<unknown>,
  run: (db: Db) => Promise<T>,
  parameters: unknown,
) {
  const before = await read(db, false)
  const actor = await approve(db, ctx, tool, action, target, { before, parameters })
  try {
    return await transaction(db, async (client) => {
      if (ctx.signal.aborted) throw new AdminError('cancelled')
      // Match the catalog lock ordering used by server edits and group deletion.
      await lockCatalog(client)
      const current = await read(client, true)
      if (digest(before) !== digest(current)) throw new AdminError('server_revision_conflict')
      if (ctx.signal.aborted) throw new AdminError('cancelled')
      const result = await run(client)
      if (ctx.signal.aborted) throw new AdminError('cancelled')
      await audit(client, {
        tool,
        action,
        target,
        before,
        after: result,
        parameters,
        status: 'succeeded',
        actor,
        context: ctx,
        approval: 'approved',
      })
      return result
    })
  } catch (cause) {
    await audit(db, {
      tool,
      action,
      target,
      before,
      after: { code: cause instanceof AdminError ? cause.code : 'operation_failed' },
      parameters,
      status: 'failed',
      actor,
      context: ctx,
      approval: 'approved',
    })
    throw cause
  }
}
