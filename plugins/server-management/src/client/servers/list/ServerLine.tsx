import { format, formatDate, localized, serverCopy } from '../../../shared/i18n.ts'
import { type ServerListItem } from '../../../shared/dto/servers.ts'
import { bytes, meter, ratio } from '../../shared/resources.ts'
import { ServerStatus } from '../components/ServerStatus.tsx'
export function ServerLine(props: {
  active: string
  server: ServerListItem
  onOpen: (id: string) => void
  onTerminal: (id: string) => void
  onRemove: (server: ServerListItem) => void
}) {
  const { server, active } = props
  const copy = serverCopy(active).ui
  const resources = server.resources
  const installation = server.installRequiredSoftware
  const installationLabel =
    installation.applicability === 'not-applicable'
      ? copy.notApplicable
      : installation.enabled
        ? copy.yes
        : copy.no
  return (
    <tr onClick={() => props.onOpen(server.id)}>
      <td>
        <button
          className="smp-server-open"
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            props.onOpen(server.id)
          }}
        >
          {server.name}
        </button>
        {server.upgradeCount > 0 && (
          <small>
            {serverCopy(active).upgrades.needsUpgrade} ({server.upgradeCount})
          </small>
        )}
      </td>
      <td className="mono">
        {server.address.host}:{server.address.port}
      </td>
      <td>{server.operatingSystem.label}</td>
      <td title={server.type.available ? undefined : copy.typeUnavailable}>
        {localized(server.type.name, active)}
      </td>
      <td>
        <ServerStatus active={active} status={server.status} />
      </td>
      <td>
        {installationLabel}
        {installation.applicability === 'unavailable' && (
          <small className="muted">{copy.installationUnavailable}</small>
        )}
      </td>
      <td
        className="smp-server-resources"
        title={
          resources.sampledAt
            ? format(copy.resourceSampledAt, { time: formatDate(resources.sampledAt, active) })
            : copy.resourcesUnknown
        }
      >
        <span>CPU {resources.fresh ? meter(resources.cpuPercent, '%') : '—'}</span>
        <span>
          {copy.memory}{' '}
          {resources.fresh
            ? meter(ratio(resources.memoryUsed, resources.memoryTotal), bytes(resources.memoryUsed))
            : '—'}
        </span>
        <span>
          {copy.disk}{' '}
          {resources.fresh
            ? meter(ratio(resources.diskUsed, resources.diskTotal), bytes(resources.diskUsed))
            : '—'}
        </span>
        {resources.sampledAt && !resources.fresh && <small className="muted">{copy.resourcesStale}</small>}
      </td>
      <td>{formatDate(server.lastCheckedAt, active)}</td>
      <td className="smp-server-actions">
        <button
          className="smp-server-action-icon"
          type="button"
          aria-label={copy.details}
          title={copy.details}
          onClick={(event) => {
            event.stopPropagation()
            props.onOpen(server.id)
          }}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M1.8 8s2.3-4 6.2-4 6.2 4 6.2 4-2.3 4-6.2 4S1.8 8 1.8 8Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        <button
          className="smp-server-action-icon"
          type="button"
          aria-label={copy.terminal}
          title={copy.terminal}
          onClick={(event) => {
            event.stopPropagation()
            props.onTerminal(server.id)
          }}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="m3 5 3 3-3 3M8.5 11H13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="smp-server-action-icon danger"
          type="button"
          aria-label={copy.remove}
          title={copy.remove}
          onClick={(event) => {
            event.stopPropagation()
            props.onRemove(server)
          }}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M3 4.5h10M6 4.5V2.8h4v1.7M4.5 4.5l.6 9h5.8l.6-9M6.5 7v4M9.5 7v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </td>
    </tr>
  )
}
