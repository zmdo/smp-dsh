import { Panel } from '@smp/console-kit'
import type { ServerDto } from '../../../shared/dto/servers.ts'
import { enumLabel, format, formatDate, serverCopy } from '../../../shared/i18n.ts'

/** Temporary core panel. Step 7 replaces it with the container plugin's registered panel. */
export function ContainerPanel(props: { active: string; server: ServerDto }) {
  const { active, server } = props
  const copy = serverCopy(active).ui
  const containers = server.containers ?? []
  const note =
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
    <Panel title={copy.containers}>
      <div className="smp-container-meta">
        <div>
          <span>Docker</span>
          <b className="mono">{server.docker_version || '—'}</b>
        </div>
        <div>
          <span>Compose</span>
          <b className="mono">{server.compose_version || '—'}</b>
        </div>
      </div>
      {server.containers_checked_at !== null && (
        <p className="muted">
          {format(copy.containerObserved, { time: formatDate(server.containers_checked_at, active) })}
        </p>
      )}
      {note !== '' && <p className="empty">{note}</p>}
      {containers.length > 0 && (
        <div className="table-scroll">
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
        </div>
      )}
    </Panel>
  )
}
