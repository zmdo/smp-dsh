import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Panel } from '@smp/console-kit'
import {
  componentText,
  enumLabel,
  format,
  formatDate,
  groupName as localizedGroupName,
  serverCopy,
  versionRequirement,
  statusReason,
  ServerError,
  type LocaleFace,
} from '../i18n.ts'
import {
  localized,
  defaultTypeForOs,
  sameSoftware,
  typeSupportsOs,
  type GroupView,
  type LocalizedText,
  type ServerTypeView,
  type SoftwareView,
  type TypeOptions,
} from '../definitions.ts'
import { api, displayError, requestError, responseError } from './api.ts'
import { useActiveLocale } from './locale.ts'
import { TaskHistory } from './TaskHistory.tsx'
import { EnrollmentPreview, type ConnectionResult } from './enrollment-preview.ts'
import {
  OS_CATALOG,
  osLabel,
  sameDeclaredOs,
  supportsOs,
  type DeclaredOs,
  type DetectedOs,
  type OsSupport,
} from '../operating-systems.ts'
import serversStyle from './servers.css'
import { SERVER_STATES, type ServerListItem, type ServerListPage, type DisplayStatus, type ServerGroupSummary } from '../server-list-contract.ts'
import type { ServerPageState, ServerPageSnapshot, ServerListView as ListView } from './server-page-state.ts'

interface ServerRow {
  id: string
  name: string
  host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  group_id: string | null
  group_name: string | null
  group_name_i18n: LocalizedText | null
  type_key: string
  type_name_i18n: LocalizedText
  type_available: boolean
  required_software: SoftwareView[]
  software_state: string
  region: string | null
  install_required_software: boolean
  declared_os: DeclaredOs
  detected_os: DetectedOs | null
  os_verification: string
  type_supported_os: OsSupport
  software_status: Record<
    string,
    {
      state?: string
      installed?: boolean
      detail?: string
      version?: string
      last_known_version?: string
      revision?: string
    }
  >
  host_fingerprint: string | null
  reachability: string
  status: DisplayStatus
  docker_version: string | null
  compose_version: string | null
  cpu_percent: number | null
  mem_total_bytes: number | string | null
  mem_used_bytes: number | string | null
  disk_total_bytes: number | string | null
  disk_used_bytes: number | string | null
  last_checked_at: string | null
  container_count: number | null
  containers_state: string
  containers_checked_at: string | null
  containers?: ContainerRow[]
}

interface ContainerRow {
  container_id: string
  name: string
  image: string
  status: string
  ports: string
}

interface GroupRow extends GroupView {
  server_count: number
}

interface KeyRow {
  id: string
  name: string
  fingerprint: string
}

export function installServersStyle(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@smp/console-server-management'
  tag.textContent = serversStyle
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

export function ServersPage(props: { locale: LocaleFace; pageState: ServerPageState }) {
  const active = useActiveLocale(props.locale)
  const { screen, serverId, editing, listView } = useSyncExternalStore(props.pageState.subscribe, props.pageState.getSnapshot)
  const setScreen = (screen: ServerPageSnapshot['screen']) => props.pageState.update({ screen })
  const setServerId = (serverId: string) => props.pageState.update({ serverId })
  const setEditing = (editing: boolean) => props.pageState.update({ editing })
  const setListView = useCallback((listView: ListView) => props.pageState.update({ listView }), [props.pageState])
  if (screen === 'form') {
    return (
      <ServerForm
        active={active}
        editing={editing}
        serverId={serverId}
        initialGroupId={listView.groupId ?? ''}
        onDone={(id) => {
          setServerId(id)
          setScreen(id === '' ? 'list' : 'detail')
        }}
        onCancel={() => {
          setScreen(serverId === '' ? 'list' : 'detail')
        }}
      />
    )
  }
  if (screen === 'detail')
    return (
      <ServerDetail
        active={active}
        id={serverId}
        onEdit={() => {
          setEditing(true)
          setScreen('form')
        }}
        onTerminal={() => {
          setScreen('terminal')
        }}
        onBack={() => {
          setScreen('list')
        }}
      />
    )
  if (screen === 'terminal')
    return (
      <ServerTerminal
        active={active}
        id={serverId}
        onBack={() => {
          setScreen('detail')
        }}
      />
    )
  return (
    <ServerList
      active={active}
      view={listView}
      onView={setListView}
      onOpen={(id) => {
        setServerId(id)
        setEditing(false)
        setScreen('detail')
      }}
      onCreate={() => {
        setServerId('')
        setEditing(false)
        setScreen('form')
      }}
    />
  )
}

function ServerList(props: {
  active: string
  view: ListView
  onView: (view: ListView) => void
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  const { active } = props
  const copy = serverCopy(active).ui
  const { view, onView } = props
  const [result, setResult] = useState<{ key: string; data: ServerListPage }>()
  const [groups, setGroups] = useState<ServerGroupSummary[]>([])
  const [counts, setCounts] = useState({ all: 0, ungrouped: 0 })
  const [loadError, setLoadError] = useState<ServerError | null>(null)
  const [actionError, setActionError] = useState<ServerError | null>(null)
  const [groupError, setGroupError] = useState<ServerError | null>(null)
  const [groupName, setGroupName] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const dataVersion = useRef(0)
  const tableScroll = useRef<HTMLDivElement>(null)
  const params = new URLSearchParams({ q: view.query, status: view.status, order: view.order, page: String(view.page), page_size: String(view.pageSize) })
  if (view.groupId !== null) params.set('group_id', view.groupId || 'ungrouped')
  const key = params.toString()
  const latestKey = useRef(key)
  latestKey.current = key
  const data = result?.key === key ? result.data : undefined
  const loaded = data !== undefined
  const groupId = view.groupId
  const selectedGroup = groups.find(group => group.id === groupId)
  const groupLabel = groupId === null ? copy.allServers : groupId === '' ? copy.ungrouped
    : selectedGroup ? localizedGroupName(active, selectedGroup) : ''
  const total = data?.total ?? 0
  const page = data?.page ?? view.page
  const pages = Math.max(1, Math.ceil(total / view.pageSize))
  const rows = data?.items ?? []

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const version = dataVersion.current
    setLoadError(null)
    async function load() {
      try {
        const next = await api<ServerListPage>(`/console-api/servers?${key}`, { signal: controller.signal })
        if (stopped || version !== dataVersion.current || latestKey.current !== key) return
        setResult({ key, data: next })
        setGroups(next.groups.map(group => ({ ...group, server_count: group.server_count ?? 0 })))
        setCounts(next.counts)
        setLoadError(null)
        if (next.page !== view.page || next.group_id !== view.groupId) onView({ ...view, page: next.page, groupId: next.group_id })
      } catch (cause) {
        if (!stopped && version === dataVersion.current && latestKey.current === key) setLoadError(requestError(cause))
      } finally {
        if (!stopped) timer = setTimeout(() => { void load() }, 1000)
      }
    }
    timer = setTimeout(() => { void load() }, 150)
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [key, refresh, onView])

  useEffect(() => {
    if (tableScroll.current !== null) tableScroll.current.scrollTop = 0
  }, [key])

  function selectGroup(id: string | null): void {
    onView({ ...view, groupId: id, page: 1 })
    setActionError(null)
  }

  async function createGroup(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (creatingGroup) return
    setCreatingGroup(true)
    setGroupError(null)
    try {
      const group = await api<GroupRow>('/console-api/server-groups', {
        method: 'POST',
        body: JSON.stringify({ name: groupName }),
      })
      dataVersion.current += 1
      setRefresh(value => value + 1)
      setGroups((current) => [...current, group])
      selectGroup(group.id)
      setGroupName('')
      setAddingGroup(false)
    } catch (cause) {
      setGroupError(requestError(cause))
    } finally {
      setCreatingGroup(false)
    }
  }

  async function removeGroup(id: string): Promise<void> {
    setActionError(null)
    try {
      await api(`/console-api/server-groups/${id}`, { method: 'DELETE' })
      dataVersion.current += 1
      setRefresh(value => value + 1)
      setGroups((current) => current.filter((group) => group.id !== id))
      if (groupId === id) selectGroup('')
    } catch (cause) {
      setActionError(requestError(cause))
    }
  }

  return (
    <div className="smp-server-shell">
      <aside className="smp-server-sidebar">
        <header className="smp-server-group-head">
          <h2>{copy.groups}</h2>
          <button
            className="link"
            type="button"
            aria-expanded={addingGroup}
            onClick={() => {
              setAddingGroup(!addingGroup)
              setGroupError(null)
            }}
          >
            {copy.newGroup}
          </button>
        </header>
        {addingGroup && (
          <form
            className="smp-server-group-form"
            onSubmit={(event) => {
              void createGroup(event)
            }}
          >
            <input
              aria-label={copy.groupName}
              placeholder={copy.groupName}
              value={groupName}
              maxLength={80}
              required
              autoFocus
              disabled={creatingGroup}
              onChange={(event) => {
                setGroupName(event.target.value)
              }}
            />
            {groupError !== null && (
              <p className="smp-server-group-error" role="alert">
                {displayError(active, groupError)}
              </p>
            )}
            <div className="row">
              <button className="primary" type="submit" disabled={creatingGroup || groupName.trim() === ''}>
                {copy.create}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={creatingGroup}
                onClick={() => {
                  setAddingGroup(false)
                  setGroupName('')
                  setGroupError(null)
                }}
              >
                {copy.cancel}
              </button>
            </div>
          </form>
        )}
        <nav className="smp-server-groups" aria-label={copy.serverGroups}>
          <GroupChoice
            active={active}
            label={copy.allServers}
            count={counts.all}
            selected={groupId === null}
            onSelect={() => selectGroup(null)}
          />
          {groups.map((group) => (
            <GroupChoice
              active={active}
              key={group.id}
              label={localizedGroupName(active, group)}
              system={group.kind === 'system'}
              available={group.available}
              source={group.plugin_id ?? undefined}
              count={group.server_count}
              selected={groupId === group.id}
              onSelect={() => selectGroup(group.id)}
              onDelete={
                group.kind === 'user'
                  ? () => {
                      void removeGroup(group.id)
                    }
                  : undefined
              }
            />
          ))}
          <GroupChoice
            active={active}
            label={copy.ungrouped}
            count={counts.ungrouped}
            selected={groupId === ''}
            onSelect={() => selectGroup('')}
          />
        </nav>
      </aside>
      <div className="smp-server-main">
        <Panel
          title={
            <>
              {copy.instances}
              <span className="smp-server-current-group">{groupLabel}</span>
            </>
          }
          extra={
            <div className="row smp-server-tools">
              <input
                type="search"
                className="search"
                aria-label={copy.searchServers}
                maxLength={200}
                value={view.query}
                placeholder={copy.searchServers}
                onChange={(event) => {
                  onView({ ...view, query: event.target.value, page: 1 })
                }}
              />
              <select aria-label={copy.filterServerStatus} value={view.status} onChange={event => onView({ ...view, status: event.target.value, page: 1 })}>
                <option value="">{copy.allStatuses}</option>
                {SERVER_STATES.map(state => <option key={state} value={state}>{serverCopy(active).serverStatus[state]}</option>)}
              </select>
              <select aria-label={copy.serverOrder} value={view.order} onChange={event => onView({ ...view, order: event.target.value as ListView['order'], page: 1 })}>
                <option value="name">{copy.orderByName}</option><option value="last_checked">{copy.orderByLastCheck}</option>
              </select>
              <button className="primary" type="button" onClick={props.onCreate}>
                {copy.registerServer}
              </button>
            </div>
          }
        >
          {(actionError ?? loadError) !== null && (
            <p className="banner error" role="alert">
              {displayError(active, actionError ?? loadError)}
            </p>
          )}
          <div className="table-wrap smp-server-table-scroll" ref={tableScroll}>
            <table className="clickable smp-server-table" aria-label={copy.instances}>
              <thead>
                <tr>
                  <th>{copy.name}</th>
                  <th>{copy.address}</th>
                  <th>{copy.operatingSystem}</th>
                  <th>{copy.serverType}</th>
                  <th>{copy.status}</th>
                  <th>{copy.installRequiredSoftware}</th>
                  <th>{copy.resourceOverview}</th>
                  <th>{copy.lastCheck}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((server) => (
                  <ServerLine
                    active={active}
                    key={server.id}
                    server={server}
                    onOpen={props.onOpen}
                  />
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="smp-server-empty">
                {!loaded
                  ? loadError
                    ? copy.cannotLoadServers
                    : copy.loadingServers
                  : view.query.trim() !== '' || view.status !== ''
                    ? copy.noMatches
                    : groupId === null
                      ? copy.noServers
                      : copy.emptyGroup}
              </p>
            )}
          </div>
          <footer className="smp-server-pager" aria-label={copy.pagination}>
            <span>
              {format(total > 0 ? copy.range : copy.total, {
                count: total,
                from: (page - 1) * view.pageSize + 1,
                to: Math.min(page * view.pageSize, total),
              })}
            </span>
            <div className="row">
              <label>
                {copy.perPage}{' '}
                <select
                  aria-label={copy.pageSize}
                  value={view.pageSize}
                  onChange={(event) => {
                    onView({ ...view, pageSize: Number(event.target.value), page: 1 })
                  }}
                >
                  {[10, 20, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="secondary"
                type="button"
                disabled={!loaded || page <= 1}
                onClick={() => {
                  onView({ ...view, page: page - 1 })
                }}
              >
                {copy.previous}
              </button>
              <span aria-live="polite">{format(copy.page, { page, pages })}</span>
              <button
                className="secondary"
                type="button"
                disabled={!loaded || page >= pages}
                onClick={() => {
                  onView({ ...view, page: page + 1 })
                }}
              >
                {copy.next}
              </button>
            </div>
          </footer>
        </Panel>
      </div>
    </div>
  )
}

function GroupChoice(props: {
  active: string
  label: string
  count: number
  selected: boolean
  system?: boolean
  available?: boolean
  source?: string
  onSelect: () => void
  onDelete?: () => void
}) {
  const copy = serverCopy(props.active).ui
  return (
    <div className={`smp-server-group${props.selected ? ' is-on' : ''}`}>
      <button
        className="smp-server-group-choice"
        type="button"
        aria-current={props.selected ? 'true' : undefined}
        onClick={props.onSelect}
        title={props.source === undefined ? props.label : `${props.label} (${props.source})`}
      >
        <span>
          {props.label}
          {props.system && (
            <small className="smp-server-group-source">
              {props.available === false ? copy.pluginUnavailable : copy.systemGroup}
            </small>
          )}
        </span>
        <span className="smp-server-group-count">{props.count}</span>
      </button>
      {props.onDelete && (
        <button
          className="smp-server-group-delete"
          type="button"
          aria-label={format(copy.deleteNamedGroup, { name: props.label })}
          title={copy.deleteGroup}
          onClick={props.onDelete}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3 4.5h10M6 4.5V2.8h4v1.7M4.5 4.5l.6 9h5.8l.6-9M6.5 7v4M9.5 7v4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}

function ServerLine(props: { active: string; server: ServerListItem; onOpen: (id: string) => void }) {
  const { server, active } = props
  const copy = serverCopy(active).ui
  const resources = server.resources
  const installation = server.installRequiredSoftware
  const installationLabel = installation.applicability === 'not-applicable' ? copy.notApplicable : installation.enabled ? copy.yes : copy.no
  return (
    <tr onClick={() => props.onOpen(server.id)}>
      <td><button className="smp-server-open" type="button" onClick={event => { event.stopPropagation(); props.onOpen(server.id) }}>{server.name}</button></td>
      <td className="mono">{server.address.host}:{server.address.port}</td>
      <td>{server.operatingSystem.label}</td>
      <td title={server.type.available ? undefined : copy.typeUnavailable}>{localized(server.type.name, active)}</td>
      <td><ServerStatus active={active} status={server.status} /></td>
      <td>{installationLabel}{installation.applicability === 'unavailable' && <small className="muted">{copy.installationUnavailable}</small>}</td>
      <td className="smp-server-resources" title={resources.sampledAt ? format(copy.resourceSampledAt, { time: formatDate(resources.sampledAt, active) }) : copy.resourcesUnknown}>
        <span>CPU {resources.fresh ? meter(resources.cpuPercent, '%') : '—'}</span>
        <span>{copy.memory} {resources.fresh ? meter(ratio(resources.memoryUsed, resources.memoryTotal), bytes(resources.memoryUsed)) : '—'}</span>
        <span>{copy.disk} {resources.fresh ? meter(ratio(resources.diskUsed, resources.diskTotal), bytes(resources.diskUsed)) : '—'}</span>
        {resources.sampledAt && !resources.fresh && <small className="muted">{copy.resourcesStale}</small>}
      </td>
      <td>{formatDate(server.lastCheckedAt, active)}</td>
    </tr>
  )
}

function ServerStatus({ active, status }: { active: string; status: DisplayStatus }) {
  return <span className={`pill smp-server-status ${status.code}`} title={status.reasons.map(reason => statusReason(active, reason)).join('\n')}>
    {serverCopy(active).serverStatus[status.code]}
  </span>
}

function ServerForm(props: {
  active: string
  editing: boolean
  serverId: string
  initialGroupId: string
  onDone: (id: string) => void
  onCancel: () => void
}) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [method, setMethod] = useState('private_key')
  const [keyId, setKeyId] = useState('')
  const [keyName, setKeyName] = useState('')
  const [secret, setSecret] = useState('')
  const [groupId, setGroupId] = useState(props.initialGroupId)
  const [typeKey, setTypeKey] = useState('')
  const [savedType, setSavedType] = useState<ServerTypeView | undefined>()
  const [original, setOriginal] = useState<{ groupId: string; typeKey: string } | undefined>()
  const [osFamily, setOsFamily] = useState('')
  const [osRelease, setOsRelease] = useState('')
  const [osText, setOsText] = useState('')
  const [savedOs, setSavedOs] = useState<DeclaredOs | undefined>()
  const [region, setRegion] = useState('')
  const [auto, setAuto] = useState(false)
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [defaults, setDefaults] = useState<TypeOptions | undefined>()
  const [serverLoaded, setServerLoaded] = useState(!props.editing)
  const [error, setError] = useState<ServerError | null>(null)
  const [connection, setConnection] = useState<(ConnectionResult & { revision: number }) | undefined>()
  const [loadedServer, setLoadedServer] = useState<ServerRow | undefined>()
  const [pending, setPending] = useState<'test' | 'identify' | null>(null)
  const [previews] = useState(() => new EnrollmentPreview())
  const [cachedIdentification, setCachedIdentification] = useState(false)
  const automaticIdentification = useRef<string | undefined>(undefined)
  const requests = useRef(0)
  const authRevision = useRef({ key: '', revision: 0 })
  const identityRevision = useRef({ key: '', revision: 0 })
  const authentication = {
    server_id: props.editing ? props.serverId : undefined,
    host: host.trim(),
    ssh_port: Number(port),
    ssh_user: user.trim(),
    auth_method: method,
    ssh_key_id: method === 'private_key' ? keyId : undefined,
    secret: method === 'private_key' && keyId !== '' ? undefined : secret,
  }
  const authenticationKey = JSON.stringify(authentication)
  if (authRevision.current.key !== authenticationKey)
    authRevision.current = { key: authenticationKey, revision: authRevision.current.revision + 1 }
  previews.sync(authRevision.current.revision)
  const currentConnection =
    connection?.revision === authRevision.current.revision && connection.expires_at > Date.now()
      ? connection
      : undefined
  const savedAuthenticationKey = loadedServer
    ? JSON.stringify({
        server_id: props.serverId,
        host: loadedServer.host,
        ssh_port: loadedServer.ssh_port,
        ssh_user: loadedServer.ssh_user,
        auth_method: loadedServer.auth_method,
        ssh_key_id: loadedServer.auth_method === 'private_key' ? (loadedServer.ssh_key_id ?? '') : undefined,
        secret: loadedServer.auth_method === 'private_key' && loadedServer.ssh_key_id ? undefined : '',
      })
    : ''
  const canTest =
    host.trim() !== '' &&
    user.trim() !== '' &&
    Number.isInteger(Number(port)) &&
    Number(port) > 0 &&
    Number(port) <= 65535 &&
    ((method === 'private_key' && keyId !== '') ||
      secret.trim() !== '' ||
      (method === 'password' && authenticationKey === savedAuthenticationKey))

  useEffect(
    () => () => {
      requests.current += 1
      previews.clear()
    },
    [],
  )
  useEffect(() => {
    if (!connection) return
    const timer = setTimeout(() => setConnection(undefined), Math.max(0, connection.expires_at - Date.now()))
    return () => clearTimeout(timer)
  }, [connection])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    void Promise.all([
      api<GroupRow[]>('/console-api/server-groups'),
      api<KeyRow[]>('/console-api/ssh-keys'),
      api<TypeOptions>('/console-api/server-types'),
    ])
      .then(([nextGroups, nextKeys, nextDefaults]) => {
        if (stopped) return
        setGroups(nextGroups)
        setKeys(nextKeys)
        setDefaults(nextDefaults)
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(requestError(cause))
      })
    return () => {
      stopped = true
    }
  }, [])

  useEffect(() => {
    if (!props.editing || props.serverId === '') return
    let stopped = false
    void api<ServerRow>(`/console-api/servers/${props.serverId}`)
      .then((server) => {
        if (stopped) return
        setLoadedServer(server)
        setName(server.name)
        setHost(server.host)
        setPort(String(server.ssh_port))
        setUser(server.ssh_user)
        setMethod(server.auth_method)
        setKeyId(server.ssh_key_id ?? '')
        setGroupId(server.group_id ?? '')
        setRegion(server.region ?? '')
        setAuto(server.install_required_software)
        setTypeKey(server.type_key)
        setSavedOs(server.declared_os)
        setOsFamily(server.declared_os.kind === 'custom' ? 'custom' : server.declared_os.family)
        setOsRelease(server.declared_os.kind === 'catalog' ? server.declared_os.releaseKey : '')
        setOsText(server.declared_os.kind === 'custom' ? server.declared_os.text : '')
        setSavedType({
          key: server.type_key,
          name_i18n: server.type_name_i18n,
          software: server.required_software,
          supportedOs: server.type_supported_os,
        })
        setOriginal({ groupId: server.group_id ?? '', typeKey: server.type_key })
        setServerLoaded(true)
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(requestError(cause))
      })
    return () => {
      stopped = true
    }
  }, [props.editing, props.serverId])

  const family = OS_CATALOG.find((item) => item.key === osFamily)
  const release = family?.releases.find((item) => item.key === osRelease)
  const declaredOs: DeclaredOs | undefined =
    osFamily === 'custom'
      ? osText.trim()
        ? { kind: 'custom', text: osText.trim() }
        : undefined
      : release
        ? {
            kind: 'catalog',
            family: osFamily,
            releaseKey: release.key,
            version: release.version,
            precision: release.precision,
            name: release.name,
          }
        : savedOs?.kind === 'catalog' && savedOs.family === osFamily && savedOs.releaseKey === osRelease
          ? savedOs
          : undefined
  const choices = groupId === '' ? defaults : groups.find((group) => group.id === groupId)
  const applicableTypes =
    declaredOs === undefined ? [] : (choices?.types ?? []).filter((type) => typeSupportsOs(type, declaredOs))
  const selected =
    choices?.types.find((type) => type.key === typeKey) ?? (savedType?.key === typeKey ? savedType : undefined)
  const originalBinding = original?.groupId === groupId && original.typeKey === typeKey
  const available = choices?.available === true && applicableTypes.some((type) => type.key === typeKey)
  const configuredSoftware = (selected?.software ?? []).filter(
    (item) =>
      !item.whenOs ||
      (declaredOs !== undefined && supportsOs({ kind: 'explicit', selectors: item.whenOs }, declaredOs)),
  )
  const identityKey = JSON.stringify([authRevision.current.revision, groupId, typeKey, declaredOs])
  if (identityRevision.current.key !== identityKey)
    identityRevision.current = { key: identityKey, revision: identityRevision.current.revision + 1 }
  const selection = { groupId, typeKey, os: declaredOs, types: choices?.types ?? [] }
  const identified = currentConnection ? previews.cached(authRevision.current.revision, selection) : undefined
  const savedSystemCurrent =
    loadedServer !== undefined &&
    authenticationKey === savedAuthenticationKey &&
    loadedServer.group_id === (groupId || null) &&
    loadedServer.type_key === typeKey &&
    declaredOs !== undefined &&
    sameDeclaredOs(loadedServer.declared_os, declaredOs)
  const software = identified?.required_software ?? configuredSoftware
  const softwareStatus = identified?.software_status ?? (savedSystemCurrent ? loadedServer?.software_status : undefined)
  const architecture =
    identified?.detected_os.architecture ?? (savedSystemCurrent ? loadedServer?.detected_os?.architecture : undefined)
  const canSave =
    defaults !== undefined &&
    serverLoaded &&
    declaredOs !== undefined &&
    selected !== undefined &&
    (available ||
      (originalBinding && !choices?.available && savedOs !== undefined && sameDeclaredOs(declaredOs, savedOs)))

  useEffect(() => {
    if (!serverLoaded || declaredOs === undefined || typeKey !== '') return
    const defaultType = applicableTypes.find((type) => type.key === defaultTypeForOs(choices, declaredOs))
    if (defaultType !== undefined) setTypeKey(defaultType.key)
  }, [serverLoaded, declaredOs, typeKey, choices, applicableTypes])

  useEffect(() => {
    if (automaticIdentification.current !== identityKey) return
    automaticIdentification.current = undefined
    if (canTest && available && !busy) void identify(false)
  }, [identityKey, canTest, available, busy])

  function queueIdentification(nextGroup: string, nextType: string): void {
    automaticIdentification.current = JSON.stringify([
      authRevision.current.revision, nextGroup, nextType, declaredOs,
    ])
  }

  function changeGroup(id: string): void {
    const next = id === '' ? defaults : groups.find((group) => group.id === id)
    const allowed =
      declaredOs === undefined ? [] : (next?.types ?? []).filter((type) => typeSupportsOs(type, declaredOs))
    const type =
      allowed.find((item) => item.key === typeKey) ??
      allowed.find((item) => item.key === defaultTypeForOs(next, declaredOs))
    if (selected === undefined || type === undefined || !sameSoftware(selected, type)) setAuto(false)
    if (type && (groupId !== id || type.key !== typeKey)) queueIdentification(id, type.key)
    setGroupId(id)
    setTypeKey(type?.key ?? '')
  }

  async function preview(): Promise<void> {
    const request = ++requests.current,
      revision = authRevision.current.revision
    setError(null)
    setConnection(undefined)
    setPending('test')
    try {
      const result = await previews.test(revision, authentication, true)
      if (request === requests.current && revision === authRevision.current.revision)
        setConnection({ ...result, revision })
    } catch (cause) {
      if (request === requests.current && revision === authRevision.current.revision) setError(requestError(cause))
    } finally {
      if (request === requests.current) setPending(null)
    }
  }

  async function identify(force = true): Promise<void> {
    if (!canTest || (force && !currentConnection)) return
    const request = ++requests.current,
      revision = authRevision.current.revision,
      scope = identityRevision.current.revision
    setPending(currentConnection ? 'identify' : 'test')
    setError(null)
    try {
      const connection = await previews.test(revision, authentication)
      if (
        request !== requests.current || revision !== authRevision.current.revision ||
        scope !== identityRevision.current.revision
      ) return
      setConnection({ ...connection, revision })
      setPending('identify')
      const preview = await previews.identify(revision, authentication, selection, force)
      if (
        request !== requests.current ||
        revision !== authRevision.current.revision ||
        scope !== identityRevision.current.revision
      )
        return
      const result = preview.identification
      setConnection({ ...preview.connection, revision })
      setCachedIdentification(preview.cached)
      const os = result.declared_os
      setSavedOs(os)
      setOsFamily(os.kind === 'custom' ? 'custom' : os.family)
      setOsRelease(os.kind === 'catalog' ? os.releaseKey : '')
      setOsText(os.kind === 'custom' ? os.text : '')
      if (result.type_key !== typeKey) setAuto(false)
      setTypeKey(result.type_key)
    } catch (cause) {
      if (
        request === requests.current &&
        revision === authRevision.current.revision &&
        scope === identityRevision.current.revision
      ) {
        const error = requestError(cause)
        setError(error)
        if (
          error.code === 'connection_test_required' ||
          error.code === 'fingerprint_mismatch' ||
          error.code.startsWith('ssh_')
        )
          setConnection(undefined)
      }
    } finally {
      if (request === requests.current) setPending(null)
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!canSave || busy || pending !== null) return
    setBusy(true)
    setError(null)
    try {
      let nextKey = keyId
      if (method === 'private_key' && keyId === '' && secret.trim() !== '') {
        const created = await api<KeyRow>('/console-api/ssh-keys', {
          method: 'POST',
          body: JSON.stringify({ name: keyName.trim() || name.trim(), secret }),
        })
        nextKey = created.id
      }
      const body = {
        name: name.trim(),
        host: host.trim(),
        ssh_port: Number(port),
        ssh_user: user.trim(),
        auth_method: method,
        group_id: groupId === '' ? null : groupId,
        type_key: typeKey,
        declared_os: declaredOs,
        region,
        install_required_software: software.length > 0 && auto,
        inspect_after_save: identified !== undefined,
        ssh_key_id: method === 'private_key' ? nextKey : undefined,
        secret: method === 'password' && secret.trim() !== '' ? secret : undefined,
      }
      const saved = props.editing
        ? await api<ServerRow>(`/console-api/servers/${props.serverId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await api<ServerRow>('/console-api/servers', { method: 'POST', body: JSON.stringify(body) })
      props.onDone(saved.id)
    } catch (cause) {
      setError(requestError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={props.editing ? copy.editServer : copy.registerServer}
      extra={
        <button className="link" type="button" onClick={props.onCancel}>
          {copy.back}
        </button>
      }
    >
      {error !== null && (
        <p className="banner error" role="alert">
          {displayError(active, error)}
        </p>
      )}
      <form
        className="panel-form"
        onSubmit={(event) => {
          void save(event)
        }}
      >
        <div className="triple">
          <label className="field">
            {copy.name}
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          </label>
          <label className="field">
            {copy.group}
            <select
              value={groupId}
              onChange={(event) => {
                changeGroup(event.target.value)
              }}
            >
              <option value="">{copy.ungrouped}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id} disabled={!group.available && group.id !== original?.groupId}>
                  {localizedGroupName(active, group)}
                  {group.available ? '' : ` (${copy.pluginUnavailable})`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {copy.region}
            <input
              value={region}
              onChange={(event) => {
                setRegion(event.target.value)
              }}
              placeholder={copy.autoRegion}
            />
          </label>
        </div>
        <section className="smp-server-form-section" aria-label={copy.authenticationInfo}>
          <h2>{copy.authenticationInfo}</h2>
          <div className="smp-server-form-section-body">
            <div className="smp-server-address-row">
              <label className="field">
                {copy.hostAddress}
                <input
                  value={host}
                  onChange={(event) => {
                    setHost(event.target.value)
                  }}
                />
              </label>
              <label className="field">
                {copy.port}
                <input
                  value={port}
                  onChange={(event) => {
                    setPort(event.target.value)
                  }}
                />
              </label>
            </div>
            <label className="field">
              {copy.user}
              <input
                value={user}
                onChange={(event) => {
                  setUser(event.target.value)
                }}
              />
            </label>
            <label className="field">
              {copy.authMethod}
              <select
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value)
                  setSecret('')
                }}
              >
                <option value="private_key">{copy.privateKey}</option>
                <option value="password">{copy.password}</option>
              </select>
            </label>
            {method === 'private_key' ? (
              <>
                <label className="field">
                  {copy.existingKey}
                  <select
                    value={keyId}
                    onChange={(event) => {
                      setKeyId(event.target.value)
                    }}
                  >
                    <option value="">{copy.noKey}</option>
                    {keys.map((key) => (
                      <option key={key.id} value={key.id}>
                        {key.name}
                      </option>
                    ))}
                  </select>
                </label>
                {keyId === '' && (
                  <>
                    <label className="field">
                      {copy.newKeyName}
                      <input
                        value={keyName}
                        onChange={(event) => {
                          setKeyName(event.target.value)
                        }}
                      />
                    </label>
                    <label className="field">
                      {copy.pasteKey}
                      <textarea
                        value={secret}
                        onChange={(event) => {
                          setSecret(event.target.value)
                        }}
                        placeholder={copy.secretHint}
                      />
                    </label>
                  </>
                )}
              </>
            ) : (
              <label className="field">
                {copy.password}
                <input
                  type="password"
                  value={secret}
                  onChange={(event) => {
                    setSecret(event.target.value)
                  }}
                />
              </label>
            )}
            {method === 'password' && loadedServer?.auth_method === 'password' && (
              <p className="muted">{copy.savedPasswordHint}</p>
            )}
            {currentConnection && (
              <p className="banner ok">{format(copy.connected, { fingerprint: currentConnection.fingerprint })}</p>
            )}
          </div>
          <footer>
            <button
              className="secondary"
              type="button"
              disabled={!canTest || pending !== null || busy}
              onClick={() => {
                void preview()
              }}
            >
              {pending === 'test' ? copy.testingConnection : copy.testConnection}
            </button>
          </footer>
        </section>
        <section className="smp-server-form-section" aria-label={copy.systemInfo}>
          <h2>{copy.systemInfo}</h2>
          <div className="smp-server-form-section-body">
            <label className="field">
              {copy.operatingSystem}
              <select
                value={osFamily}
                required
                onChange={(event) => {
                  setOsFamily(event.target.value)
                  setOsRelease('')
                  setOsText('')
                  setTypeKey('')
                  setAuto(false)
                }}
              >
                <option value="">{copy.osChoose}</option>
                {OS_CATALOG.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
                <option value="custom">{copy.osOther}</option>
              </select>
            </label>
            {osFamily === 'custom' ? (
              <label className="field">
                {copy.osCustom}
                <input
                  value={osText}
                  required
                  maxLength={200}
                  placeholder="openSUSE Leap 15.6"
                  onChange={(event) => setOsText(event.target.value)}
                />
              </label>
            ) : (
              <label className="field">
                {copy.osRelease}
                <select
                  value={osRelease}
                  required
                  disabled={family === undefined}
                  onChange={(event) => {
                    setOsRelease(event.target.value)
                    setTypeKey('')
                    setAuto(false)
                  }}
                >
                  <option value="">{copy.osChoose}</option>
                  {savedOs?.kind === 'catalog' &&
                    savedOs.family === osFamily &&
                    !family?.releases.some((item) => item.key === savedOs.releaseKey) && (
                      <option value={savedOs.releaseKey}>{savedOs.name}</option>
                    )}
                  {family?.releases.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              {copy.serverType}
              <select
                value={typeKey}
                onChange={(event) => {
                  queueIdentification(groupId, event.target.value)
                  setTypeKey(event.target.value)
                  setAuto(false)
                }}
                disabled={!choices?.available || declaredOs === undefined}
              >
                {selected !== undefined && !applicableTypes.some((type) => type.key === typeKey) && (
                  <option value={typeKey} disabled>
                    {localized(selected.name_i18n, active)} ({copy.typeUnavailable})
                  </option>
                )}
                {typeKey === '' && <option value="">{copy.osChoose}</option>}
                {applicableTypes.map((type) => (
                  <option key={type.key} value={type.key}>
                    {localized(type.name_i18n, active)}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">{copy.osNote}</p>
            {declaredOs !== undefined && applicableTypes.length === 0 && (
              <p className="banner error">{copy.osNoTypes}</p>
            )}
            {declaredOs !== undefined && choices !== undefined && !available && (
              <p className="muted">
                {choices.available ? serverCopy(active).errors.os_type_unsupported : copy.typeUnavailable}
              </p>
            )}
            {props.editing && !originalBinding && <p className="muted">{copy.typeChangeNote}</p>}
            {architecture && (
              <p className="muted">
                {copy.architecture}: {architecture}
              </p>
            )}
            {identified && (
              <p className="muted">
                {format(copy.systemIdentified, { time: formatDate(identified.detected_at, active) })}
                {cachedIdentification && ` ${copy.cachedSystemInformation}`}
              </p>
            )}
            {identified && !identified.software_available && <p className="muted">{copy.typeUnavailable}</p>}
            <RequiredSoftware active={active} software={software} status={softwareStatus} />
            <label className="smp-server-auto-install">
              <input
                type="checkbox"
                checked={software.length > 0 && auto}
                disabled={software.length === 0 || !available}
                onChange={(event) => {
                  setAuto(event.target.checked)
                }}
              />{' '}
              {copy.autoInstall}
            </label>
            <p className="muted">{copy.manualSystemNote}</p>
          </div>
          <footer>
            <button
                className="secondary smp-server-identify"
              type="button"
              disabled={!currentConnection || pending !== null || busy}
              onClick={() => {
                void identify()
              }}
            >
              {pending === 'identify' ? copy.identifyingSystem : copy.identifySystem}
            </button>
            {!currentConnection && <span className="muted">{copy.identifySystemHint}</span>}
          </footer>
        </section>
        <div className="row">
          <button className="primary" type="submit" disabled={busy || pending !== null || !canSave}>
            {copy.save}
          </button>
        </div>
      </form>
    </Panel>
  )
}

function SoftwareState(props: { active: string; state: string }) {
  const copy = serverCopy(props.active).ui
  const labels: Record<string, string> = {
    ready: copy.softwareReady,
    pending: copy.softwarePending,
    unknown: copy.softwareUnknown,
    unavailable: copy.softwareUnavailable,
  }
  return (
    <span className={`pill ${props.state === 'ready' ? 'online' : props.state === 'pending' ? 'queued' : 'unknown'}`}>
      {enumLabel(labels, props.state)}
    </span>
  )
}

function RequiredSoftware(props: {
  active: string
  software: readonly SoftwareView[]
  status?: ServerRow['software_status']
}) {
  const copy = serverCopy(props.active).ui
  return (
    <section className="smp-required-software" aria-label={copy.requiredSoftware}>
      <h3>{copy.requiredSoftware}</h3>
      {props.software.length === 0 ? (
        <p className="muted">{copy.noRequiredSoftware}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{copy.softwareName}</th>
                <th>{copy.versionRequirement}</th>
                <th>{copy.installedVersion}</th>
                <th>{copy.status}</th>
              </tr>
            </thead>
            <tbody>
              {props.software.map((component) => {
                const item = props.status?.[component.id]
                const state = item?.state ?? (item?.installed === true ? 'installed' : 'unknown')
                const status =
                  state === 'installed'
                    ? copy.installed
                    : state === 'missing'
                      ? copy.notInstalled
                      : item?.detail
                        ? copy.softwareDetectionFailed
                        : copy.softwareNotChecked
                const text = componentText(props.active, component)
                return (
                  <tr key={component.id}>
                    <td>
                      <strong>{text.name}</strong>
                      {text.summary && <small className="muted">{text.summary}</small>}
                    </td>
                    <td>{versionRequirement(props.active, component.versions)}</td>
                    <td className="smp-software-version">
                      {state === 'installed' ? item?.version || '—' : '—'}
                      {state === 'unknown' && item?.last_known_version && (
                        <small className="muted">
                          {format(copy.lastKnownVersion, { version: item.last_known_version })}
                        </small>
                      )}
                    </td>
                    <td>
                      {status}
                      {item?.detail && <small className="muted">{item.detail}</small>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ServerDetail(props: {
  active: string
  id: string
  onEdit: () => void
  onTerminal: () => void
  onBack: () => void
}) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [server, setServer] = useState<ServerRow | undefined>()
  const [error, setError] = useState<ServerError | null>(null)
  const [queued, setQueued] = useState(false)
  const [taskRefresh, setTaskRefresh] = useState(0)

  useEffect(() => {
    let stopped = false
    const load = () => {
      void api<ServerRow>(`/console-api/servers/${props.id}`)
        .then((next) => {
          if (!stopped) setServer(next)
        })
        .catch((cause: unknown) => {
          if (!stopped) setError(requestError(cause))
        })
    }
    load()
    const timer = setInterval(load, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [props.id])

  async function act(path: string): Promise<void> {
    setError(null)
    setQueued(false)
    try {
      await api(path, { method: 'POST' })
      setQueued(true)
      setTaskRefresh(value => value + 1)
    } catch (cause) {
      setError(requestError(cause))
    }
  }

  async function remove(): Promise<void> {
    try {
      await api(`/console-api/servers/${props.id}`, { method: 'DELETE' })
      props.onBack()
    } catch (cause) {
      setError(requestError(cause))
    }
  }

  if (server === undefined)
    return (
      <Panel title={copy.server}>
        <p className="muted">{error === null ? copy.loading : displayError(active, error)}</p>
      </Panel>
    )
  const missing = server.type_available && server.required_software.length > 0 && server.software_state !== 'ready'
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
        {server.status.reasons.length > 0 && <ul className="smp-server-status-reasons">{server.status.reasons.map((reason, index) => <li key={index}>{statusReason(active, reason)}</li>)}</ul>}
        <div className="node-grid">
          <div><span>{copy.connectionStatus}</span>{enumLabel(serverCopy(active).reach, server.reachability)}</div>
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
        <div className="node-actions">
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

function ServerTerminal(props: { active: string; id: string; onBack: () => void }) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [text, setText] = useState('')
  const [error, setError] = useState<ServerError | null>(null)
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(
      `${proto}//${location.host}/console-api/servers/terminal?id=${encodeURIComponent(props.id)}`,
    )
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (event) => {
      const chunk = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
      setText((current) => `${current}${chunk}`.slice(-20000))
    }
    socket.onerror = () => {
      setError(new ServerError('terminal_failed'))
    }
    const host = document.querySelector<HTMLElement>('.terminal-host')
    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN || host === null) return
      const cols = Math.min(300, Math.max(20, Math.floor(host.clientWidth / 8)))
      const rows = Math.min(120, Math.max(5, Math.floor(host.clientHeight / 18)))
      socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
    const onKey = (event: KeyboardEvent) => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('terminal-host')) return
      event.preventDefault()
      const key =
        event.key === 'Enter'
          ? '\r'
          : event.key === 'Backspace'
            ? '\u007f'
            : event.key === 'Tab'
              ? '\t'
              : event.key.length === 1
                ? event.key
                : ''
      if (key !== '') socket.send(key)
    }
    host?.addEventListener('keydown', onKey)
    socket.addEventListener('open', sendResize)
    const observer = new ResizeObserver(sendResize)
    if (host !== null) observer.observe(host)
    return () => {
      observer.disconnect()
      host?.removeEventListener('keydown', onKey)
      socket.close()
    }
  }, [props.id])
  return (
    <Panel
      title={copy.terminal}
      extra={
        <button className="link" type="button" onClick={props.onBack}>
          {copy.back}
        </button>
      }
    >
      {error !== null ? <p className="banner error">{displayError(active, error)}</p> : null}
      <div className="terminal-page">
        <pre className="terminal-host" tabIndex={0} style={{ color: '#f2f3f5', whiteSpace: 'pre-wrap', margin: 0 }}>
          {text || copy.terminalHint}
        </pre>
      </div>
    </Panel>
  )
}

function meter(percent: number | null, label: string): string {
  if (percent === null || !Number.isFinite(percent)) return '—'
  return `${Math.round(percent)}% ${label === '%' ? '' : label}`.trim()
}

function ratio(used: number | string | null, total: number | string | null): number | null {
  if (used === null || total === null) return null
  const left = Number(used)
  const right = Number(total)
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return null
  return Math.max(0, Math.min(100, (100 * left) / right))
}

function bytes(value: number | string | null): string {
  if (value === null) return '—'
  const size = Number(value)
  if (!Number.isFinite(size)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let next = size
  let index = 0
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024
    index += 1
  }
  return `${index === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[index]}`
}
