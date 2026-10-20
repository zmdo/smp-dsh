import type { Json } from '../../shared/contracts/common.ts'
import { ServerError } from '../../shared/errors.ts'
import { errorPayload } from '../../shared/i18n.ts'
import { scrubValue } from '../remote/parse.ts'
import { scriptCommand } from '../recipes/script.ts'
import type { WorkerContext } from '../execution/context.ts'
import { owned } from '../execution/ownership.ts'
import { readSettings } from './persistence/settings-repository.ts'
import { saveExtensionObservation } from './persistence/observation-repository.ts'
import type { ServerExtensionRegistry } from './registry.ts'

export interface ExtensionInspectionResult {
  key: string
  owner: string
  status: 'succeeded' | 'failed'
  result?: Json
  error?: Json
}

/** Read-only checks run inside the claimed inspect job; the core owns SSH, timeout and fencing. */
export async function runExtensionInspections(
  context: WorkerContext,
  extensions: ServerExtensionRegistry,
): Promise<ExtensionInspectionResult[]> {
  const entries = extensions.inspectionsFor(context.server)
  const results: ExtensionInspectionResult[] = []
  for (const entry of entries) {
    await context.guard()
    let inspection = extensions.inspection(entry.key)
    if (inspection === undefined) {
      results.push({
        key: entry.key,
        owner: entry.owner,
        status: 'failed',
        error: errorPayload(new ServerError('extension_inspection_unavailable', { key: entry.key })),
      })
      continue
    }
    let settingRevision: string | undefined
    if (inspection.entry.settingsKey !== undefined) {
      const settings = extensions.settings(context.server, inspection.entry.settingsKey)
      const section = inspection.entry.settingsKey.slice(settings.entry.owner.length + 1)
      const stored = (await readSettings(context.db, context.server.id, settings.entry.owner, section)).rows[0]
      settingRevision = stored?.revision ?? '0'
      const value = stored?.value ?? settings.runtime.defaults
      if (inspection.runtime.enabled?.(value) === false) continue
    }
    try {
      const response = await context.session.exec(scriptCommand(inspection.script), inspection.script.timeoutMs, {
        outputLimitBytes: inspection.script.outputLimitBytes,
      })
      if (response.code !== 0)
        throw new ServerError('extension_inspection_failed', {
          key: entry.key,
          detail: response.stderr.slice(-500),
        })
      inspection = extensions.inspection(entry.key)
      if (inspection === undefined)
        throw new ServerError('extension_inspection_unavailable', { key: entry.key })
      if (inspection.entry.settingsKey !== undefined) {
        const settings = extensions.settings(context.server, inspection.entry.settingsKey)
        const section = inspection.entry.settingsKey.slice(settings.entry.owner.length + 1)
        const latest = (await readSettings(context.db, context.server.id, settings.entry.owner, section)).rows[0]
        if ((latest?.revision ?? '0') !== settingRevision)
          throw new ServerError('extension_inspection_setting_changed', { key: entry.key })
      }
      const result = inspection.runtime.validate(response.stdout)
      results.push({ key: entry.key, owner: entry.owner, status: 'succeeded', result })
    } catch (cause) {
      results.push({
        key: entry.key,
        owner: entry.owner,
        status: 'failed',
        error: errorPayload(
          cause instanceof ServerError
            ? cause
            : new ServerError('extension_inspection_failed', {
                key: entry.key,
                detail: cause instanceof Error ? cause.message : '',
              }),
        ),
      })
    }
  }
  if (results.length === 0) return results
  await owned(context.db, context.job, async (client) => {
    for (const item of results) {
      await saveExtensionObservation(client, {
        serverId: context.server.id,
        owner: item.owner,
        key: item.key,
        status: item.status,
        result: item.status === 'succeeded' ? (item.result ?? null) : null,
        error: item.error ?? null,
        configRevision: String(context.server.config_revision),
        definitionRevision: context.job.definition_revision,
      })
      if (item.status === 'succeeded') {
        const inspection = extensions.inspection(item.key)
        await inspection?.runtime.commit?.(client, context.server, item.result ?? null)
      }
    }
  })
  return results
}

export function extensionIssues(results: readonly ExtensionInspectionResult[]): ReturnType<typeof errorPayload>[] {
  return results
    .filter((item) => item.status === 'failed')
    .map((item) => item.error ?? errorPayload(new ServerError('extension_inspection_failed', { key: item.key })))
}

export function extensionResult(results: readonly ExtensionInspectionResult[]): Json {
  return results.map((item) => ({
    key: item.key,
    owner: item.owner,
    status: item.status,
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
  }))
}

export function scrubExtensionResults(results: readonly ExtensionInspectionResult[], secret: string) {
  return scrubValue(extensionResult(results), secret)
}
