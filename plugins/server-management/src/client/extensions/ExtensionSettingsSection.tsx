import { useCallback, useEffect, useState } from 'react'
import type { ServerDto } from '../../shared/dto/servers.ts'
import { type ServerError } from '../../shared/errors.ts'
import { displayError, localized, serverCopy } from '../../shared/i18n.ts'
import { requestError } from '../shared/api.ts'
import { ExtensionHost } from './ExtensionHost.tsx'
import { extensionApi } from './api.ts'
import { SETTINGS_SECTION_SLOT, type ExtensionCatalogEntry, type RenderSlot, type SlotService } from './slots.ts'

export function ExtensionSettingsSection(props: {
  active: string
  server: ServerDto
  entry: ExtensionCatalogEntry
  renderSlot?: RenderSlot
  slots?: SlotService
  onSaved: () => void
}) {
  const { active, entry, server } = props
  const copy = serverCopy(active).ui
  const [value, setValue] = useState<unknown>()
  const [draft, setDraft] = useState<unknown>()
  const [revision, setRevision] = useState('0')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [planned, setPlanned] = useState<{ id: string; digest: string; expires_at: string }>()
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<ServerError | null>(null)
  const dirty = !loading && JSON.stringify(value) !== JSON.stringify(draft)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setConflict(false)
    try {
      const current = await extensionApi.settings(server.id, entry.key)
      setValue(current.value)
      setDraft(current.value)
      setRevision(current.revision)
      setSaved(false)
    } catch (cause) {
      setError(requestError(cause))
    } finally {
      setLoading(false)
    }
  }, [entry.key, server.id])

  useEffect(() => {
    void load()
  }, [load])

  async function save(): Promise<void> {
    if (!dirty || saving || entry.affectsExecution === true) return
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      const current = await extensionApi.saveSettings(server.id, entry.key, draft, revision)
      setValue(current.value)
      setDraft(current.value)
      setRevision(current.revision)
      setSaved(true)
      props.onSaved()
    } catch (cause) {
      const next = requestError(cause)
      if (next.code === 'extension_settings_conflict') setConflict(true)
      else setError(next)
    } finally {
      setSaving(false)
    }
  }

  async function plan(): Promise<void> {
    if (!dirty || saving || entry.affectsExecution !== true) return
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      setPlanned(await extensionApi.planSettings(server.id, entry.key, draft, revision))
    } catch (cause) {
      const next = requestError(cause)
      if (next.code === 'extension_settings_conflict') setConflict(true)
      else setError(next)
    } finally {
      setSaving(false)
    }
  }

  async function applyPlan(): Promise<void> {
    if (planned === undefined || saving) return
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      const current = await extensionApi.applySettings(server.id, entry.key, planned.id, planned.digest)
      setValue(current.value)
      setDraft(current.value)
      setRevision(current.revision)
      setPlanned(undefined)
      setSaved(true)
      props.onSaved()
    } catch (cause) {
      const next = requestError(cause)
      if (next.code === 'extension_settings_conflict') setConflict(true)
      else setError(next)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="smp-extension-settings" aria-label={localized(entry.name, active)}>
      <div className="row smp-extension-settings-head">
        <h3>{localized(entry.name, active)}</h3>
        {saved && !dirty && <span className="muted">{copy.extensionSaved}</span>}
      </div>
      {loading ? (
        <p className="muted">{copy.loading}</p>
      ) : (
        <ExtensionHost
          active={active}
          slot={SETTINGS_SECTION_SLOT}
          entry={entry.key}
          owner={{
            server,
            active,
            refresh: props.onSaved,
            api: extensionApi,
            settings: {
              value: draft,
              revision,
              dirty,
              saving,
              error,
              onChange: (value) => {
                setDraft(value)
                setPlanned(undefined)
              },
            },
          }}
          renderSlot={props.renderSlot as never}
          slots={props.slots}
        />
      )}
      {error !== null && <p className="banner error">{displayError(active, error)}</p>}
      {conflict && (
        <p className="banner error">
          {copy.extensionConflictReload}{' '}
          <button className="link" type="button" onClick={() => { void load() }}>
            {copy.extensionReload}
          </button>
        </p>
      )}
      {entry.affectsExecution === true && <p className="muted">{copy.extensionRequiresPlan}</p>}
      {entry.affectsExecution === true ? (
        <>
          {planned !== undefined && (
            <p className="banner">
              {copy.extensionPlanReady} <code>{planned.digest.slice(0, 12)}</code>
            </p>
          )}
          <div className="row smp-settings-actions">
            {planned === undefined ? (
              <button
                className="primary"
                type="button"
                disabled={!dirty || saving || loading}
                onClick={() => { void plan() }}
              >
                {saving ? copy.saving : copy.extensionPlanCreate}
              </button>
            ) : (
              <>
                <button className="primary" type="button" disabled={saving} onClick={() => { void applyPlan() }}>
                  {saving ? copy.saving : copy.extensionPlanApply}
                </button>
                <button className="secondary" type="button" disabled={saving} onClick={() => setPlanned(undefined)}>
                  {copy.extensionPlanCancel}
                </button>
              </>
            )}
            {dirty && <span className="muted">{copy.unsavedChanges}</span>}
          </div>
        </>
      ) : (
        <div className="row smp-settings-actions">
          <button
            className="primary"
            type="button"
            disabled={!dirty || saving || loading}
            onClick={() => { void save() }}
          >
            {saving ? copy.saving : copy.save}
          </button>
          <button className="secondary" type="button" disabled={!dirty || saving} onClick={() => setDraft(value)}>
            {copy.reset}
          </button>
          {dirty && <span className="muted">{copy.unsavedChanges}</span>}
        </div>
      )}
    </section>
  )
}
