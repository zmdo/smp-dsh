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
        <button className="link" type="button" onClick={(event) => { event.stopPropagation(); props.onOpen(server.id) }}>
          {copy.details}
        </button>
        <button className="link" type="button" onClick={(event) => { event.stopPropagation(); props.onTerminal(server.id) }}>
          {copy.terminal}
        </button>
        <button className="link danger" type="button" onClick={(event) => { event.stopPropagation(); props.onRemove(server) }}>
          {copy.remove}
        </button>
      </td>
    </tr>
  )
}
