import { randomUUID } from 'node:crypto'
import type { Json } from '../../shared/contracts/common.ts'
import { type Db } from '../database/connection.ts'
import { transaction } from '../database/transaction.ts'
import { HttpError } from '../errors.ts'
import { digest } from '../recipes/canonical.ts'
import * as proposals from './persistence/settings-plan-repository.ts'
import { readSettings, saveSettings } from './persistence/settings-repository.ts'

const TTL_MS = 10 * 60 * 1000

/** Plan an execution-affecting extension setting. The digest binds the exact value and revision. */
export async function planExtensionSettings(
  db: Db,
  input: { serverId: string; owner: string; section: string; value: Json; expectedRevision: string },
): Promise<{ id: string; digest: string; expires_at: Date }> {
  return transaction(db, async (client) => {
    const current = (await readSettings(client, input.serverId, input.owner, input.section)).rows[0]
    if ((current?.revision ?? '0') !== input.expectedRevision) throw new HttpError(409, 'extension_settings_conflict')
    const id = randomUUID()
    const planDigest = digest({
      serverId: input.serverId,
      owner: input.owner,
      section: input.section,
      value: input.value,
      expectedRevision: input.expectedRevision,
    })
    const expiresAt = new Date(Date.now() + TTL_MS)
    const row = (
      await proposals.insertProposal(client, { ...input, id, digest: planDigest, expiresAt })
    ).rows[0]!
    return { id: row.id, digest: row.digest, expires_at: row.expires_at }
  })
}

/** Apply only after rechecking plan ownership, expiry, digest and the current settings revision. */
export async function applyExtensionSettingsPlan(
  db: Db,
  input: { serverId: string; owner: string; section: string; planId: string; digest: string },
): Promise<{ value: Json; revision: string }> {
  return transaction(db, async (client) => {
    const plan = (await proposals.lockProposal(client, input.planId)).rows[0]
    if (
      plan === undefined ||
      plan.server_id !== input.serverId ||
      plan.owner !== input.owner ||
      plan.section_key !== input.section
    )
      throw new HttpError(404, 'extension_plan_not_found')
    if (plan.state !== 'pending') throw new HttpError(409, 'extension_plan_not_pending')
    if (plan.expires_at.getTime() <= Date.now()) throw new HttpError(409, 'extension_plan_expired')
    if (plan.digest !== input.digest) throw new HttpError(422, 'extension_plan_invalid')
    const current = (await readSettings(client, input.serverId, input.owner, input.section)).rows[0]
    const revision = current?.revision ?? '0'
    if (revision !== String(plan.expected_revision)) throw new HttpError(409, 'extension_settings_conflict')
    const saved = (
      await saveSettings(client, {
        serverId: input.serverId,
        owner: input.owner,
        section: input.section,
        value: plan.value,
        expectedRevision: revision,
      })
    ).rows[0]
    if (saved === undefined) throw new HttpError(409, 'extension_settings_conflict')
    await proposals.markApplied(client, input.planId, saved.revision)
    return saved
  })
}
