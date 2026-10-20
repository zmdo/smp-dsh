import { Panel } from '@smp/console-kit'
import {
  displayError,
  enumLabel,
  format,
  formatDate,
  localized,
  serverCopy,
  statusReason,
} from '../../../shared/i18n.ts'
import { osLabel } from '../../../shared/operating-systems.ts'
import { RequiredSoftware } from '../components/RequiredSoftware.tsx'
import { ServerStatus, SoftwareState } from '../components/ServerStatus.tsx'
import { MoveServer } from './MoveServer.tsx'
import { TaskHistory } from './TaskHistory.tsx'
import type { ServerDetailProps } from './types.ts'
import { useServerDetail } from './useServerDetail.ts'
export function ServerDetail(props: ServerDetailProps) {
  const { active, copy, server, error, queued, taskRefresh, moving, setMoving, act, remove } =
    useServerDetail(props)

  if (server === undefined)
    return (
      <Panel title={copy.server}>
        <p className="muted">{error === null ? copy.loading : displayError(active, error)}</p>
      </Panel>
    )
  const missing =
    server.type_available && server.required_software.length > 0 && server.software_state !== 'ready'
  const containers = server.containers ?? []
  const containerNote =
    server.containers_state === 'unavailable'
      ? copy.containerUnavailable
      : server.containers_state === 'failed'
        ? copy.containerError
        : server.containers_state === 'unknown'
          ? copy.containerUnknown
          : containers.length === 0
            ? copy.noContainers
            : ''
  return (
    <Panel
      title={server.name}
      extra={
        <button className="link" type="button" onClick={props.onBack}>
          {copy.back}
        </button>
      }
    >
      {error !== null ? <p className="banner error">{displayError(active, error)}</p> : null}
      {queued ? <p className="banner ok">{copy.jobQueued}</p> : null}
      {!server.type_available && <p className="banner error">{copy.typeUnavailable}</p>}
      {server.os_verification !== 'matched' && (
        <p className={`banner ${server.os_verification === 'mismatch' ? 'error' : ''}`}>
          {server.os_verification === 'mismatch' ? copy.osMismatch : copy.osUnverified}
        </p>
      )}
      <div className="node-card">
        <div className="node-title">
          <span className="name-text">
            {server.host}:{server.ssh_port}
          </span>
          <ServerStatus active={active} status={server.status} />
        </div>
        {server.status.reasons.length > 0 && (
          <ul className="smp-server-status-reasons">
            {server.status.reasons.map((reason, index) => (
              <li key={index}>{statusReason(active, reason)}</li>
            ))}
          </ul>
        )}
        <div className="node-grid">
          <div>
            <span>{copy.connectionStatus}</span>
            {enumLabel(serverCopy(active).reach, server.reachability)}
          </div>
          <div>
            <span>{copy.user}</span>
            {server.ssh_user}
          </div>
          <div>
            <span>{copy.region}</span>
            {server.region || '—'}
          </div>
          <div>
            <span>{copy.operatingSystem}</span>
            {osLabel(server.declared_os)}
          </div>
          <div>
            <span>{copy.osDetected}</span>
            {server.detected_os
              ? `${server.detected_os.family.replace('builtin/', '')} ${server.detected_os.version} · ${server.detected_os.architecture}`
              : copy.osUnverified}
          </div>
          <div>
            <span>{copy.serverType}</span>
            {localized(server.type_name_i18n, active)}
          </div>
          <div>
            <span>{copy.requiredSoftware}</span>
            <SoftwareState active={active} state={server.software_state} />
          </div>
          <div>
            <span>Docker</span>
            {server.docker_version || '—'}
          </div>
          <div>
            <span>Compose</span>
            {server.compose_version || '—'}
          </div>
          <div>
            <span>{copy.hostFingerprint}</span>
            <b className="mono">{server.host_fingerprint || copy.notPinned}</b>
          </div>
        </div>
        {moving && <MoveServer active={active} server={server} onClose={() => setMoving(false)} />}
        <div className="node-actions">
          <button className="secondary" type="button" onClick={() => setMoving(true)}>
            {serverCopy(active).upgrades.moveServer}
          </button>
          <button className="secondary" type="button" onClick={props.onUpgrades}>
            {serverCopy(active).upgrades.openUpgrades} ({server.upgrade_count})
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              void act(`/console-api/servers/${server.id}/test`)
            }}
          >
            {copy.testConnection}
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              void act(`/console-api/servers/${server.id}/inspect`)
            }}
          >
            {copy.refresh}
          </button>
          {missing ? (
            <button
              className="secondary"
              type="button"
              onClick={() => {
                void act(`/console-api/servers/${server.id}/install-components`)
              }}
            >
              {copy.installComponents}
            </button>
          ) : null}
          <button className="secondary" type="button" onClick={props.onTerminal}>
            {copy.terminal}
          </button>
          <button className="secondary" type="button" onClick={props.onEdit}>
            {copy.edit}
          </button>
          <button
            className="link danger"
            type="button"
            onClick={() => {
              void remove()
            }}
          >
            {copy.delete}
          </button>
        </div>
      </div>
      <RequiredSoftware active={active} software={server.required_software} status={server.software_status} />
      <h2>{copy.containers}</h2>
      {containerNote !== '' && <p className="empty">{containerNote}</p>}
      {server.containers_checked_at !== null && (
        <p className="muted">
          {format(copy.containerObserved, { time: formatDate(server.containers_checked_at, active) })}
        </p>
      )}
      {containers.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{copy.name}</th>
              <th>{copy.image}</th>
              <th>{copy.status}</th>
              <th>{copy.ports}</th>
            </tr>
          </thead>
          <tbody>
            {containers.map((item) => (
              <tr key={item.container_id}>
                <td>{item.name}</td>
                <td>{item.image}</td>
                <td>
                  <span className={`pill ${item.status}`}>
                    {enumLabel(serverCopy(active).containerStatus, item.status)}
                  </span>
                </td>
                <td>{item.ports}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <TaskHistory key={props.id} active={active} serverId={props.id} refresh={taskRefresh} />
    </Panel>
  )
}
