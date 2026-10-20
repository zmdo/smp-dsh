import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Panel } from '@smp/console-kit'
import { displayError, serverCopy } from '../../../shared/i18n.ts'
import { ServerError } from '../../../shared/errors.ts'
import { api, requestError } from '../../shared/api.ts'
import type { DetailPanel, ServerPageState, TaskViewState } from '../../shared/server-page-state.ts'
import { ServerStatus } from '../components/ServerStatus.tsx'
import { ContainerPanel } from './ContainerPanel.tsx'
import { ServerDetail } from '../detail/ServerDetail.tsx'
import { ServerForm } from '../form/ServerForm.tsx'
import { ServerTerminal } from '../terminal/ServerTerminal.tsx'
import { TaskHistory } from '../tasks/TaskHistory.tsx'
import { useServerResource } from './useServerResource.ts'

export function ServerWorkspace(props: {
  active: string
  serverId: string
  pageState: ServerPageState
  onBack: () => void
  onUpgrades: (serverId: string) => void
}) {
  const { active, pageState, serverId } = props
  const snapshot = useSyncExternalStore(pageState.subscribe, pageState.getSnapshot)
  const panel = snapshot.detailPanel
  const copy = serverCopy(active).ui
  const { server, error, refresh } = useServerResource(serverId)
  const [queued, setQueued] = useState(false)
  const [actionError, setActionError] = useState<ServerError | null>(null)
  const taskView = pageState.taskView(serverId)
  const setTaskView = useCallback(
    (view: TaskViewState) => {
      pageState.setTaskView(serverId, view)
    },
    [pageState, serverId],
  )

  useEffect(() => {
    if (error?.code === 'server_not_found') props.onBack()
  }, [error?.code, props.onBack])

  async function act(path: string): Promise<void> {
    setActionError(null)
    setQueued(false)
    try {
      await api(path, { method: 'POST' })
      setQueued(true)
      refresh()
    } catch (cause) {
      setActionError(requestError(cause))
    }
  }

  async function remove(): Promise<void> {
    setActionError(null)
    try {
      await api(`/console-api/servers/${serverId}`, { method: 'DELETE' })
      props.onBack()
    } catch (cause) {
      setActionError(requestError(cause))
    }
  }

  const choices: { key: DetailPanel; label: string; select: () => void }[] = [
    {
      key: 'detail',
      label: copy.serverDetails,
      select: () => pageState.selectDetailPanel('detail'),
    },
    {
      key: 'tasks',
      label: copy.taskReport,
      select: () => pageState.selectDetailPanel('tasks'),
    },
    { key: 'terminal', label: copy.terminal, select: () => pageState.selectDetailPanel('terminal') },
    {
      key: 'containers',
      label: copy.containers,
      select: () => pageState.selectDetailPanel('containers'),
    },
    { key: 'config', label: copy.configuration, select: () => pageState.selectDetailPanel('config') },
  ]

  return (
    <div className="smp-server-workspace">
      <header className="smp-server-workspace-head">
        <button className="link" type="button" onClick={props.onBack}>
          {copy.back}
        </button>
        <div className="smp-server-workspace-identity">
          <h2>{server?.name ?? copy.server}</h2>
          {server && (
            <span className="mono">
              {server.host}:{server.ssh_port}
            </span>
          )}
        </div>
        {server && <ServerStatus active={active} status={server.status} />}
      </header>
      {server === undefined ? (
        <section className="smp-server-workspace-panel">
          <Panel title={copy.serverDetails}>
            <p className="muted">{error === null ? copy.loading : displayError(active, error)}</p>
          </Panel>
        </section>
      ) : (
        <div className="smp-server-workspace-body">
          <aside className="smp-server-workspace-nav">
            <nav aria-label={copy.workspacePanels}>
              {choices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  className={`smp-server-workspace-choice${panel === choice.key ? ' is-on' : ''}`}
                  aria-current={panel === choice.key ? 'page' : undefined}
                  onClick={choice.select}
                >
                  {choice.label}
                </button>
              ))}
            </nav>
          </aside>
          <label className="smp-server-workspace-select-wrap">
            <span>{copy.workspacePanels}</span>
            <select
              className="smp-server-workspace-select"
              aria-label={copy.workspacePanels}
              value={panel}
              onChange={(event) => {
                const choice = choices.find((item) => item.key === event.target.value)
                choice?.select()
              }}
            >
              {choices.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <section className="smp-server-workspace-panel">
            {panel === 'tasks' ? (
              <Panel title={copy.taskReport}>
                <TaskHistory
                  key={serverId}
                  active={active}
                  serverId={serverId}
                  view={taskView}
                  onView={setTaskView}
                />
              </Panel>
            ) : panel === 'containers' ? (
              <ContainerPanel active={active} server={server} />
            ) : panel === 'terminal' ? (
              <ServerTerminal
                active={active}
                id={serverId}
                embedded
                onBack={() => pageState.selectDetailPanel('detail')}
              />
            ) : panel === 'config' ? (
              <ServerForm
                active={active}
                editing
                embedded
                serverId={serverId}
                initialGroupId={server.group_id ?? ''}
                title={copy.configuration}
                onDone={(id) => pageState.openServer(id)}
                onCancel={() => pageState.selectDetailPanel('detail')}
              />
            ) : (
              <ServerDetail
                active={active}
                server={server}
                error={actionError ?? error}
                queued={queued}
                onTest={() => {
                  void act(`/console-api/servers/${serverId}/test`)
                }}
                onInspect={() => {
                  void act(`/console-api/servers/${serverId}/inspect`)
                }}
                onInstall={() => {
                  void act(`/console-api/servers/${serverId}/install-components`)
                }}
                onDelete={() => {
                  void remove()
                }}
                onEdit={() => pageState.selectDetailPanel('config')}
                onTerminal={() => pageState.selectDetailPanel('terminal')}
                onUpgrades={() => props.onUpgrades(serverId)}
              />
            )}
          </section>
        </div>
      )}
    </div>
  )
}
