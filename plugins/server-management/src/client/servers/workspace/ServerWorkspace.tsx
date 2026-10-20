import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Panel } from '@smp/console-kit'
import { displayError, serverCopy } from '../../../shared/i18n.ts'
import { ServerError } from '../../../shared/errors.ts'
import { api, requestError } from '../../shared/api.ts'
import type { DetailPanel, ServerPageState, TaskViewState } from '../../shared/server-page-state.ts'
import { ServerStatus } from '../components/ServerStatus.tsx'
import { ContainerPanel } from './ContainerPanel.tsx'
import { ServerDetail } from '../detail/ServerDetail.tsx'
import { ServerSettings } from '../settings/ServerSettings.tsx'
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
  const [terminalOpened, setTerminalOpened] = useState(false)
  const [settingsOpened, setSettingsOpened] = useState(false)
  const [terminalEpoch, setTerminalEpoch] = useState(0)
  const [terminalAutoConnect, setTerminalAutoConnect] = useState(true)
  const previousIdentity = useRef('')
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
  const identity = server === undefined ? '' : terminalIdentity(server)
  useEffect(() => {
    if (identity === '') return
    if (previousIdentity.current === '') {
      previousIdentity.current = identity
      return
    }
    if (previousIdentity.current === identity) return
    previousIdentity.current = identity
    if (!terminalOpened) return
    // A changed host, user or key must not silently reuse the old terminal.
    setTerminalAutoConnect(false)
    setTerminalEpoch((value) => value + 1)
  }, [identity, terminalOpened])

  useEffect(() => {
    if (panel === 'terminal') setTerminalOpened(true)
    if (panel === 'config') setSettingsOpened(true)
  }, [panel])

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
            {terminalOpened && (
              <div className="smp-server-terminal-layer" hidden={panel !== 'terminal'}>
                <ServerTerminal
                  key={`${serverId}:${terminalEpoch}`}
                  active={active}
                  id={serverId}
                  visible={panel === 'terminal'}
                  autoConnect={terminalAutoConnect}
                  embedded
                  onBack={() => pageState.selectDetailPanel('detail')}
                />
              </div>
            )}
            {settingsOpened && (
              <div className="smp-server-settings-layer" hidden={panel !== 'config'}>
                <ServerSettings
                  active={active}
                  serverId={serverId}
                  server={server}
                  onSaved={refresh}
                  onDeleted={props.onBack}
                />
              </div>
            )}
            {panel === 'terminal' || panel === 'config' ? null : panel === 'tasks' ? (
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

function terminalIdentity(server: {
  host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  host_fingerprint: string | null
}): string {
  return JSON.stringify([
    server.host,
    server.ssh_port,
    server.ssh_user,
    server.auth_method,
    server.ssh_key_id,
    server.host_fingerprint,
  ])
}
