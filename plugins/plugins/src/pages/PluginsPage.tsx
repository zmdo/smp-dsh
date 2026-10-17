import { useEffect, useState, useSyncExternalStore } from 'react'
import { Panel } from '@smp/console-kit'
import { pluginsCopy } from '../copy.ts'
import { globalRows, type InventoryEntry, type PluginRow, type PluginStatus, type PresetGroup } from '../rows.ts'

interface LocaleFace {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

interface InventorySnapshot {
  entries: readonly InventoryEntry[]
  agentPresets?: readonly PresetGroup[]
}

interface RemoteInventory {
  list(): Promise<RemoteResult<InventorySnapshot>>
}

const PILL: Record<PluginStatus, string> = {
  enabled: 'succeeded',
  disabled: 'offline',
  failed: 'failed',
  preset: 'queued',
  pending: 'queued',
  loading: 'queued',
  unloading: 'queued',
}

function messageOf(error: { message?: string } | undefined, fallback: string): string {
  return error?.message !== undefined && error.message !== '' ? error.message : fallback
}

export function PluginsPage(props: { locale: LocaleFace; inventory: RemoteInventory }) {
  const locale = useSyncExternalStore(listener => props.locale.subscribe(listener), () => props.locale.getSnapshot())
  const copy = pluginsCopy(locale.active)
  const [entries, setEntries] = useState<readonly InventoryEntry[]>([])
  const [presets, setPresets] = useState<readonly PresetGroup[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let stopped = false
    setLoading(true)
    void props.inventory.list().then(response => {
      if (stopped) return
      setLoading(false)
      if (!response.ok || response.value === undefined) {
        setError(messageOf(response.error, copy.loadFailed))
        return
      }
      setEntries(response.value.entries)
      setPresets(response.value.agentPresets ?? [])
      setError('')
    }).catch((cause: unknown) => {
      if (stopped) return
      setLoading(false)
      setError(cause instanceof Error ? cause.message : copy.loadFailed)
    })
    return () => { stopped = true }
  }, [props.inventory, copy.loadFailed, reloadKey])

  const rows = globalRows(entries, presets, locale.active, query)
  return (
    <Panel title={copy.title}>
      {error !== '' && <p className="banner error">{error}</p>}
      <p>
        <input
          className="search"
          type="search"
          aria-label={copy.search}
          placeholder={copy.search}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </p>
      {loading ? <p className="muted">{copy.loading}</p>
        : rows.length === 0 ? <p className="empty">{query.trim() === '' ? copy.empty : copy.noMatch}</p>
          : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{copy.name}</th>
                    <th>{copy.summary}</th>
                    <th>{copy.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => <PluginLine key={row.id} row={row} copy={copy} />)}
                </tbody>
              </table>
            </div>
          )}
      {error !== '' && <p><button className="secondary" type="button" onClick={() => setReloadKey(current => current + 1)}>{copy.retry}</button></p>}
    </Panel>
  )
}

function PluginLine(props: { row: PluginRow; copy: ReturnType<typeof pluginsCopy> }) {
  const { row, copy } = props
  const label = copy[row.status === 'loading' ? 'loadingPhase' : row.status]
  const detail = row.status === 'preset' && row.enabledIn.length > 0 ? `${label} · ${row.enabledIn.join(' · ')}` : label
  return (
    <tr>
      <td>{row.title}</td>
      <td>{row.description}</td>
      <td><span className={`pill ${PILL[row.status]}`}>{detail}</span></td>
    </tr>
  )
}
