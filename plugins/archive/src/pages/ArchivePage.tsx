import { useEffect, useState, useSyncExternalStore } from 'react'
import { Panel } from '@smp/console-kit'
import { archiveCopy } from '../copy.ts'
import { sessionMatches, type SessionSearchBy } from '../query.ts'

interface LocaleFace {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

interface SessionRow {
  id: string
  title?: string
  displayTitle: string
  origin?: 'subagent'
  updatedAt: number
}

interface SessionListState {
  ids: string[]
  byId: Record<string, SessionRow>
  phase: 'pending' | 'ready'
}

interface SessionList {
  getSnapshot(): SessionListState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
}

interface WorkspaceList {
  getSnapshot(): { archivedSessionIds: readonly string[] }
  subscribe(listener: () => void): () => void
}

interface ArchivePageProps {
  locale: LocaleFace
  sessions: { list: SessionList; refresh(): Promise<void> }
  workspaces: {
    list: WorkspaceList
    unarchiveSession(sessionId: string): Promise<void>
  }
  uiWorkspace: { openSession(sessionId: string): void }
  layout: { selectPanel(id: string | null): void }
}

const PAGE_STYLE = `
.smp-console .smp-archive-tools { display: flex; gap: 8px; margin-bottom: 12px; }
.smp-console .smp-archive-tools select { width: 140px; flex: none; }
.smp-console .smp-archive-tools input { flex: 1; min-width: 0; }
.smp-console .smp-archive-table { width: 100%; border-collapse: collapse; }
.smp-console .smp-archive-table th, .smp-console .smp-archive-table td {
  text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); vertical-align: middle;
}
.smp-console .smp-archive-id { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; word-break: break-all; }
.smp-console .smp-archive-actions { display: flex; gap: 8px; justify-content: flex-end; }
`

export function installArchiveStyle(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@smp/console-archive'
  tag.textContent = PAGE_STYLE
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

export function ArchivePage(props: ArchivePageProps) {
  const active = useSyncExternalStore(
    (listener) => props.locale.subscribe(listener),
    () => props.locale.getSnapshot().active,
  )
  const copy = archiveCopy(active)
  const catalog = useSyncExternalStore(
    (listener) => props.sessions.list.subscribe(listener),
    () => props.sessions.list.getSnapshot(),
  )
  const workspaces = useSyncExternalStore(
    (listener) => props.workspaces.list.subscribe(listener),
    () => props.workspaces.list.getSnapshot(),
  )
  const [by, setBy] = useState<SessionSearchBy>('title')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    void props.sessions.refresh()
  }, [props.sessions])

  const archived = new Set(workspaces.archivedSessionIds)
  const rows = catalog.ids.flatMap((id) => {
    const row = catalog.byId[id]
    if (row === undefined || row.origin === 'subagent') return []
    const title = row.displayTitle
    return sessionMatches({ id: row.id, title }, by, query) ? [{ ...row, title, archived: archived.has(row.id) }] : []
  })

  function open(id: string): void {
    props.uiWorkspace.openSession(id)
    props.layout.selectPanel(null)
  }

  function restore(id: string): void {
    setError('')
    setMessage('')
    setBusy(id)
    void props.workspaces.unarchiveSession(id).then(() => {
      setPending('')
    }).catch((cause: unknown) => {
      setError(cause instanceof Error && cause.message !== '' ? cause.message : copy.restoreFailed)
    }).finally(() => {
      setBusy('')
    })
  }

  function remove(id: string): void {
    setError('')
    setMessage('')
    setBusy(id)
    void fetch('/console-api/sessions/delete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { detail?: unknown }
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : copy.removeFailed)
      setPending('')
      setMessage(copy.removed)
      await props.sessions.refresh()
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : copy.removeFailed)
    }).finally(() => {
      setBusy('')
    })
  }

  return (
    <>
      {error !== '' && <p className="banner error">{error}</p>}
      {message !== '' && <p className="banner ok">{message}</p>}
      <Panel title={copy.title}>
        <div className="smp-archive-tools">
          <select aria-label={copy.searchBy} value={by} onChange={(event) => setBy(event.target.value === 'id' ? 'id' : 'title')}>
            <option value="title">{copy.byTitle}</option>
            <option value="id">{copy.byId}</option>
          </select>
          <input aria-label={copy.search} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {catalog.phase === 'pending' && rows.length === 0 ? <p className="muted">{copy.loading}</p> : rows.length === 0 ? (
          <p className="empty">{query.trim() === '' ? copy.empty : copy.none}</p>
        ) : (
          <table className="smp-archive-table">
            <thead>
              <tr>
                <th>{copy.name}</th>
                <th>{copy.byId}</th>
                <th>{copy.updated}</th>
                <th>{copy.state}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td className="smp-archive-id">{row.id}</td>
                  <td>{row.updatedAt > 0 ? new Date(row.updatedAt).toLocaleString(active === 'zh' ? 'zh-CN' : 'en') : ''}</td>
                  <td>{row.archived ? copy.archived : copy.active}</td>
                  <td>
                    <span className="smp-archive-actions">
                      {row.archived ? (
                        <button className="secondary" type="button" disabled={busy === row.id} onClick={() => restore(row.id)}>{copy.restore}</button>
                      ) : (
                        <button className="secondary" type="button" onClick={() => open(row.id)}>{copy.open}</button>
                      )}
                      {row.archived && pending !== row.id && (
                        <button className="link danger" type="button" disabled={busy === row.id} onClick={() => { setPending(row.id); setError(''); setMessage('') }}>{copy.remove}</button>
                      )}
                      {row.archived && pending === row.id && (
                        <>
                          <button className="link danger" type="button" disabled={busy === row.id} onClick={() => remove(row.id)}>{copy.confirm}</button>
                          <button className="link" type="button" disabled={busy === row.id} onClick={() => setPending('')}>{copy.cancel}</button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}
