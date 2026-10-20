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
              onChange: setDraft,
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
      <div className="row smp-settings-actions">
        <button
          className="primary"
          type="button"
          disabled={!dirty || saving || loading || entry.affectsExecution === true}
          onClick={() => { void save() }}
        >
          {saving ? copy.saving : copy.save}
        </button>
        <button className="secondary" type="button" disabled={!dirty || saving} onClick={() => setDraft(value)}>
          {copy.reset}
        </button>
        {dirty && <span className="muted">{copy.unsavedChanges}</span>}
      </div>
    </section>
  )
}
