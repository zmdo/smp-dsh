import { useEffect, useState } from 'react'
import { registerServerPanel, registerSettingsSection, type ExtensionSlotOwner, type SlotService } from '@smp/console-server-management/client-api'
import type { ContainerSnapshot } from './model.ts'
import { pollSnapshots } from './poll.ts'
import en from '../locale/en.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }
import css from './style.css'

const owner = '@smp/console-server-containers'
const copyFor = (active: string) => (active === 'zh' ? zh : en).ui

function ContainersPanel(props: ExtensionSlotOwner) {
  const copy = copyFor(props.active)
  const server = props.server
  const docker = server.software_status[`${owner}/docker-engine`]
  const [snapshot, setSnapshot] = useState<ContainerSnapshot>()
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 10
  useEffect(() => {
    setSnapshot(undefined)
    setPage(1)
  }, [server.id])
  useEffect(() => {
    setLoading(true)
    return pollSnapshots({
      read: async (signal) => await props.api.data(server.id, `${owner}/container-list`, {}, signal) as ContainerSnapshot,
      publish: (value) => { setSnapshot(value); setLoading(false); setError(false) },
      failed: () => { setLoading(false); setError(true) },
      intervalMs: 10_000,
    })
  }, [props.api, server.id, refresh])
  const containers = snapshot?.rows ?? []
  const pages = Math.max(1, Math.ceil(containers.length / pageSize))
  const current = Math.min(page, pages)
  const visible = containers.slice((current - 1) * pageSize, current * pageSize)
  const stale = error || snapshot?.status === 'failed'
  return (
    <section className="panel smp-container-panel">
      <style>{css}</style>
      <div className="panel-head">
        <h2>{copy.containers}</h2>
        <button className="secondary" type="button" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>{copy.refresh}</button>
      </div>
      <div className="panel-body">
        {docker !== undefined && docker.state !== 'installed' && <p className="error">{docker.detail || copy.dockerUnavailable}</p>}
        <p className="muted">{copy.lastSuccess}: {snapshot?.last_success_at ?? copy.never}</p>
        {error && <p className="banner error">{copy.loadFailed}</p>}
        {snapshot?.status === 'failed' && <p className="banner error">{copy.inspectFailed} {snapshot.error?.params?.detail}</p>}
        {stale && snapshot?.last_success_at && <p className="muted">{copy.stale}</p>}
        {loading && !snapshot ? <p className="muted">{copy.loading}</p> : !snapshot?.last_success_at ? (
          !error && <p className="empty">{copy.noObservation}</p>
        ) : containers.length === 0 ? <p className="empty">{copy.noContainers}</p> : (
          <div className="table-scroll"><table>
            <thead><tr><th>{copy.name}</th><th>{copy.image}</th><th>{copy.status}</th><th>{copy.ports}</th></tr></thead>
            <tbody>{visible.map((item) => <tr key={item.container_id}>
              <td>{item.name}</td><td>{item.image}</td><td>{item.status}</td><td>{item.ports}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </div>
      {containers.length > pageSize && <footer className="smp-container-pager">
        <button className="secondary" type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>{copy.previous}</button>
        <span>{copy.page} {current} / {pages}</span>
        <button className="secondary" type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}>{copy.next}</button>
      </footer>}
    </section>
  )
}

function ContainerSettings(props: ExtensionSlotOwner) {
  const value = (props.settings?.value ?? {}) as { collect?: boolean }
  return <label className="smp-server-auto-install">
    <input type="checkbox" checked={value.collect !== false} disabled={props.settings?.saving}
      onChange={(event) => props.settings?.onChange({ collect: event.target.checked })} />{' '}
    {copyFor(props.active).collect}
  </label>
}

export const inject = ['slots']
export function apply(ctx: { slots: SlotService }): void {
  registerServerPanel(ctx, `${owner}/containers`, ContainersPanel)
  registerSettingsSection(ctx, `${owner}/container-settings`, ContainerSettings)
}
