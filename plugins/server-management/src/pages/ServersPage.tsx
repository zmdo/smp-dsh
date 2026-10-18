import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Panel } from '@smp/console-kit'
import { componentName, componentText, enumLabel, format, formatDate, serverCopy, ServerError, type LocaleFace } from '../i18n.ts'
import { api, displayError, requestError, responseError } from './api.ts'
import { useActiveLocale } from './locale.ts'
import serversStyle from './servers.css'

interface ServerRow {
  id: string
  name: string
  intranet_host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  group_id: string | null
  group_name: string | null
  region: string | null
  auto_install: boolean
  install_component_ids: string[]
  component_status: Record<string, { installed?: boolean; detail?: string }>
  host_key_fingerprint: string | null
  reachability: string
  docker_version: string | null
  compose_version: string | null
  cpu_percent: number | null
  mem_total_bytes: number | string | null
  mem_used_bytes: number | string | null
  disk_total_bytes: number | string | null
  disk_used_bytes: number | string | null
  last_checked_at: string | null
  container_count: number
  containers?: ContainerRow[]
  jobs?: JobRow[]
}

interface ContainerRow {
  container_id: string
  name: string
  image: string
  status: string
  ports: string
}

interface JobRow {
  id: string
  action: string
  status: string
  output_excerpt: string
  created_at: string
}

interface GroupRow {
  id: string
  name: string
  server_count: number
}

interface KeyRow {
  id: string
  name: string
  fingerprint: string
}

interface ComponentRow {
  id: string
  name: string
  summary: string
  requires: string[]
}

type Screen = 'list' | 'form' | 'detail' | 'terminal'

interface ListView {
  groupId: string | null
  query: string
  page: number
  pageSize: number
}

export function installServersStyle(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@smp/console-server-management'
  tag.textContent = serversStyle
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

export function ServersPage(props: { locale: LocaleFace }) {
  const active = useActiveLocale(props.locale)
  const [screen, setScreen] = useState<Screen>('list')
  const [serverId, setServerId] = useState('')
  const [editing, setEditing] = useState(false)
  const [listView, setListView] = useState<ListView>({ groupId: null, query: '', page: 1, pageSize: 10 })
  if (screen === 'form') {
    return <ServerForm active={active} editing={editing} serverId={serverId} initialGroupId={listView.groupId ?? ''} onDone={(id) => { setServerId(id); setScreen(id === '' ? 'list' : 'detail') }} onCancel={() => { setScreen(serverId === '' ? 'list' : 'detail') }} />
  }
  if (screen === 'detail') return <ServerDetail active={active} id={serverId} onEdit={() => { setEditing(true); setScreen('form') }} onTerminal={() => { setScreen('terminal') }} onBack={() => { setScreen('list') }} />
  if (screen === 'terminal') return <ServerTerminal active={active} id={serverId} onBack={() => { setScreen('detail') }} />
  return <ServerList active={active} view={listView} onView={setListView} onOpen={(id) => { setServerId(id); setEditing(false); setScreen('detail') }} onCreate={() => { setServerId(''); setEditing(false); setScreen('form') }} />
}

function ServerList(props: { active: string; view: ListView; onView: (view: ListView) => void; onOpen: (id: string) => void; onCreate: () => void }) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [servers, setServers] = useState<ServerRow[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<ServerError | null>(null)
  const [actionError, setActionError] = useState<ServerError | null>(null)
  const [groupError, setGroupError] = useState<ServerError | null>(null)
  const [groupName, setGroupName] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const dataVersion = useRef(0)
  const tableScroll = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stopped = false
    let loading = false
    const load = () => {
      if (loading) return
      loading = true
      const version = dataVersion.current
      void Promise.all([
        api<ServerRow[]>('/console-api/servers'),
        api<GroupRow[]>('/console-api/server-groups'),
      ]).then(([nextServers, nextGroups]) => {
        if (stopped || version !== dataVersion.current) return
        setServers(nextServers)
        setGroups(nextGroups)
        setLoaded(true)
        setLoadError(null)
      }).catch((cause: unknown) => {
        if (!stopped && version === dataVersion.current) setLoadError(requestError(cause))
      }).finally(() => { loading = false })
    }
    load()
    const timer = setInterval(load, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  const { view, onView } = props
  const groupId = loaded && view.groupId && !groups.some(group => group.id === view.groupId) ? null : view.groupId
  const groupLabel = groupId === null ? copy.allServers : groupId === '' ? copy.ungrouped : groups.find(group => group.id === groupId)?.name ?? ''
  const filtered = useMemo(() => {
    const needle = view.query.trim().toLowerCase()
    return servers.filter(server => (groupId === null || (server.group_id ?? '') === groupId)
      && (needle === '' || [server.name, server.intranet_host, server.ssh_user, server.region ?? '', server.group_name ?? ''].some(value => value.toLowerCase().includes(needle))))
  }, [view.query, groupId, servers])
  const pages = Math.max(1, Math.ceil(filtered.length / view.pageSize))
  const page = Math.min(view.page, pages)
  const rows = filtered.slice((page - 1) * view.pageSize, page * view.pageSize)

  useEffect(() => {
    if (loaded && (groupId !== view.groupId || page !== view.page)) onView({ ...view, groupId, page })
  }, [loaded, groupId, page, view, onView])

  useEffect(() => {
    if (tableScroll.current !== null) tableScroll.current.scrollTop = 0
  }, [groupId, view.query, page, view.pageSize])

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
      const group = await api<GroupRow>('/console-api/server-groups', { method: 'POST', body: JSON.stringify({ name: groupName }) })
      dataVersion.current += 1
      setGroups(current => [...current, group].sort((a, b) => a.name.localeCompare(b.name)))
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
      setGroups(current => current.filter(group => group.id !== id))
      setServers(current => current.map(server => server.group_id === id ? { ...server, group_id: null, group_name: null } : server))
      if (groupId === id) selectGroup('')
    } catch (cause) {
      setActionError(requestError(cause))
    }
  }

  async function move(id: string, groupId: string): Promise<void> {
    setActionError(null)
    try {
      const saved = await api<ServerRow>(`/console-api/servers/${id}`, { method: 'PATCH', body: JSON.stringify({ group_id: groupId === '' ? null : groupId }) })
      dataVersion.current += 1
      setServers(current => current.map(server => server.id === id ? saved : server))
    } catch (cause) {
      setActionError(requestError(cause))
    }
  }

  return (
    <div className="smp-server-shell">
      <aside className="smp-server-sidebar">
        <header className="smp-server-group-head">
          <h2>{copy.groups}</h2>
          <button className="link" type="button" aria-expanded={addingGroup} onClick={() => { setAddingGroup(!addingGroup); setGroupError(null) }}>{copy.newGroup}</button>
        </header>
        {addingGroup && (
          <form className="smp-server-group-form" onSubmit={event => { void createGroup(event) }}>
            <input aria-label={copy.groupName} placeholder={copy.groupName} value={groupName} maxLength={80} required autoFocus disabled={creatingGroup} onChange={event => { setGroupName(event.target.value) }} />
            {groupError !== null && <p className="smp-server-group-error" role="alert">{displayError(active, groupError)}</p>}
            <div className="row">
              <button className="primary" type="submit" disabled={creatingGroup || groupName.trim() === ''}>{copy.create}</button>
              <button className="secondary" type="button" disabled={creatingGroup} onClick={() => { setAddingGroup(false); setGroupName(''); setGroupError(null) }}>{copy.cancel}</button>
            </div>
          </form>
        )}
        <nav className="smp-server-groups" aria-label={copy.serverGroups}>
          <GroupChoice active={active} label={copy.allServers} count={servers.length} selected={groupId === null} onSelect={() => selectGroup(null)} />
          {groups.map(group => (
            <GroupChoice active={active} key={group.id} label={group.name} count={servers.filter(server => server.group_id === group.id).length} selected={groupId === group.id} onSelect={() => selectGroup(group.id)} onDelete={() => { void removeGroup(group.id) }} />
          ))}
          <GroupChoice active={active} label={copy.ungrouped} count={servers.filter(server => server.group_id === null).length} selected={groupId === ''} onSelect={() => selectGroup('')} />
        </nav>
      </aside>
      <div className="smp-server-main">
        <Panel title={<>{copy.instances}<span className="smp-server-current-group">{groupLabel}</span></>} extra={
          <div className="row smp-server-tools">
            <input type="search" className="search" aria-label={copy.searchServers} value={view.query} placeholder={copy.searchServers} onChange={event => { onView({ ...view, query: event.target.value, page: 1 }) }} />
            <button className="primary" type="button" onClick={props.onCreate}>{copy.registerServer}</button>
          </div>
        }>
          {(actionError ?? loadError) !== null && <p className="banner error" role="alert">{displayError(active, actionError ?? loadError)}</p>}
          <div className="table-wrap smp-server-table-scroll" ref={tableScroll}>
            <table className="clickable smp-server-table" aria-label={copy.instances}>
              <thead>
                <tr><th>{copy.name}</th><th>{copy.address}</th><th>{copy.region}</th><th>{copy.reachability}</th><th>CPU</th><th>{copy.memory}</th><th>{copy.disk}</th><th>Docker</th><th>{copy.containersCount}</th><th>{copy.lastCheck}</th><th>{copy.group}</th></tr>
              </thead>
              <tbody>
                {rows.map(server => <ServerLine active={active} key={server.id} server={server} groups={groups} onOpen={props.onOpen} onMove={(id, groupId) => { void move(id, groupId) }} />)}
              </tbody>
            </table>
            {rows.length === 0 && <p className="smp-server-empty">{!loaded ? loadError ? copy.cannotLoadServers : copy.loadingServers : view.query.trim() !== '' ? copy.noMatches : groupId === null ? copy.noServers : copy.emptyGroup}</p>}
          </div>
          <footer className="smp-server-pager" aria-label={copy.pagination}>
            <span>{format(filtered.length > 0 ? copy.range : copy.total, { count: filtered.length, from: (page - 1) * view.pageSize + 1, to: Math.min(page * view.pageSize, filtered.length) })}</span>
            <div className="row">
              <label>{copy.perPage} <select aria-label={copy.pageSize} value={view.pageSize} onChange={event => { onView({ ...view, pageSize: Number(event.target.value), page: 1 }) }}>{[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
              <button className="secondary" type="button" disabled={page === 1} onClick={() => { onView({ ...view, page: page - 1 }) }}>{copy.previous}</button>
              <span aria-live="polite">{format(copy.page, { page, pages })}</span>
              <button className="secondary" type="button" disabled={page === pages} onClick={() => { onView({ ...view, page: page + 1 }) }}>{copy.next}</button>
            </div>
          </footer>
        </Panel>
      </div>
    </div>
  )
}

function GroupChoice(props: { active: string; label: string; count: number; selected: boolean; onSelect: () => void; onDelete?: () => void }) {
  const copy = serverCopy(props.active).ui
  return (
    <div className={`smp-server-group${props.selected ? ' is-on' : ''}`}>
      <button className="smp-server-group-choice" type="button" aria-current={props.selected ? 'true' : undefined} onClick={props.onSelect} title={props.label}>
        <span>{props.label}</span><span className="smp-server-group-count">{props.count}</span>
      </button>
      {props.onDelete && <button className="smp-server-group-delete" type="button" aria-label={format(copy.deleteNamedGroup, { name: props.label })} title={copy.deleteGroup} onClick={props.onDelete}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6 4.5V2.8h4v1.7M4.5 4.5l.6 9h5.8l.6-9M6.5 7v4M9.5 7v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>}
    </div>
  )
}

function ServerLine(props: { active: string; server: ServerRow; groups: GroupRow[]; onOpen: (id: string) => void; onMove: (id: string, groupId: string) => void }) {
  const { server, active } = props
  const copy = serverCopy(active).ui
  return (
    <tr onClick={() => { props.onOpen(server.id) }}>
      <td><button className="smp-server-open" type="button" onClick={event => { event.stopPropagation(); props.onOpen(server.id) }}>{server.name}</button></td>
      <td className="mono">{server.intranet_host}:{server.ssh_port}</td>
      <td>{server.region || '—'}</td>
      <td><span className={`pill ${server.reachability}`}>{enumLabel(serverCopy(active).reach, server.reachability)}</span></td>
      <td>{meter(server.cpu_percent, '%')}</td>
      <td>{meter(ratio(server.mem_used_bytes, server.mem_total_bytes), bytes(server.mem_used_bytes))}</td>
      <td>{meter(ratio(server.disk_used_bytes, server.disk_total_bytes), bytes(server.disk_used_bytes))}</td>
      <td>{server.docker_version || '—'}</td>
      <td>{server.container_count}</td>
      <td className="nowrap">{formatDate(server.last_checked_at, active)}</td>
      <td onClick={event => { event.stopPropagation() }}>
        <select className="group-pick" aria-label={format(copy.serverGroup, { name: server.name })} value={server.group_id ?? ''} onChange={event => { props.onMove(server.id, event.target.value) }}>
          <option value="">{copy.ungrouped}</option>
          {props.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </td>
    </tr>
  )
}

function ServerForm(props: { active: string; editing: boolean; serverId: string; initialGroupId: string; onDone: (id: string) => void; onCancel: () => void }) {
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
  const [region, setRegion] = useState('')
  const [auto, setAuto] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [components, setComponents] = useState<ComponentRow[]>([])
  const [error, setError] = useState<ServerError | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void Promise.all([
      api<GroupRow[]>('/console-api/server-groups'),
      api<KeyRow[]>('/console-api/ssh-keys'),
      api<ComponentRow[]>('/console-api/components'),
    ]).then(([nextGroups, nextKeys, nextComponents]) => {
      setGroups(nextGroups)
      setKeys(nextKeys)
      setComponents(nextComponents)
    }).catch((cause: unknown) => { setError(requestError(cause)) })
  }, [])

  useEffect(() => {
    if (!props.editing || props.serverId === '') return
    void api<ServerRow>(`/console-api/servers/${props.serverId}`).then(server => {
      setName(server.name)
      setHost(server.intranet_host)
      setPort(String(server.ssh_port))
      setUser(server.ssh_user)
      setMethod(server.auth_method)
      setKeyId(server.ssh_key_id ?? '')
      setGroupId(server.group_id ?? '')
      setRegion(server.region ?? '')
      setAuto(server.auto_install)
      setPicked(server.install_component_ids)
    }).catch((cause: unknown) => { setError(requestError(cause)) })
  }, [props.editing, props.serverId])

  async function preview(): Promise<void> {
    setError(null)
    setFingerprint(null)
    try {
      const result = await api<{ ok: boolean; fingerprint?: string }>('/console-api/servers/test-connection', {
        method: 'POST',
        body: JSON.stringify({ intranet_host: host, ssh_port: Number(port), ssh_user: user, auth_method: method, secret }),
      })
      if (result.ok) setFingerprint(result.fingerprint ?? '')
      else setError(responseError(result))
    } catch (cause) {
      setError(requestError(cause))
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      let nextKey = keyId
      if (method === 'private_key' && secret.trim() !== '') {
        const created = await api<KeyRow>('/console-api/ssh-keys', { method: 'POST', body: JSON.stringify({ name: keyName.trim() || name.trim(), secret }) })
        nextKey = created.id
      }
      const body = {
        name: name.trim(),
        intranet_host: host.trim(),
        ssh_port: Number(port),
        ssh_user: user.trim(),
        auth_method: method,
        group_id: groupId === '' ? null : groupId,
        region,
        auto_install: auto,
        install_component_ids: picked,
        ssh_key_id: method === 'private_key' ? nextKey : undefined,
        secret: method === 'password' && secret.trim() !== '' ? secret : undefined,
      }
      const saved = props.editing
        ? await api<ServerRow>(`/console-api/servers/${props.serverId}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api<ServerRow>('/console-api/servers', { method: 'POST', body: JSON.stringify(body) })
      props.onDone(saved.id)
    } catch (cause) {
      setError(requestError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={props.editing ? copy.editServer : copy.registerServer} extra={<button className="link" type="button" onClick={props.onCancel}>{copy.back}</button>}>
      {error !== null ? <p className="banner error">{displayError(active, error)}</p> : null}
      {fingerprint !== null ? <p className="banner ok">{format(copy.connected, { fingerprint })}</p> : null}
      <form className="panel-form" onSubmit={event => { void save(event) }}>
        <label className="field">{copy.name}<input value={name} onChange={event => { setName(event.target.value) }} /></label>
        <div className="triple">
          <label className="field">{copy.privateAddress}<input value={host} onChange={event => { setHost(event.target.value) }} /></label>
          <label className="field">{copy.port}<input value={port} onChange={event => { setPort(event.target.value) }} /></label>
          <label className="field">{copy.user}<input value={user} onChange={event => { setUser(event.target.value) }} /></label>
        </div>
        <label className="field">{copy.authMethod}
          <select value={method} onChange={event => { setMethod(event.target.value) }}>
            <option value="private_key">{copy.privateKey}</option>
            <option value="password">{copy.password}</option>
          </select>
        </label>
        {method === 'private_key' ? (
          <>
            <label className="field">{copy.existingKey}
              <select value={keyId} onChange={event => { setKeyId(event.target.value) }}>
                <option value="">{copy.noKey}</option>
                {keys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}
              </select>
            </label>
            <label className="field">{copy.newKeyName}<input value={keyName} onChange={event => { setKeyName(event.target.value) }} /></label>
            <label className="field">{copy.pasteKey}<textarea value={secret} onChange={event => { setSecret(event.target.value) }} placeholder={copy.secretHint} /></label>
          </>
        ) : <label className="field">{copy.password}<input type="password" value={secret} onChange={event => { setSecret(event.target.value) }} /></label>}
        <div className="triple">
          <label className="field">{copy.group}
            <select value={groupId} onChange={event => { setGroupId(event.target.value) }}>
              <option value="">{copy.ungrouped}</option>
              {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </label>
          <label className="field">{copy.region}<input value={region} onChange={event => { setRegion(event.target.value) }} placeholder={copy.autoRegion} /></label>
        </div>
        <label><input type="checkbox" checked={auto} onChange={event => { setAuto(event.target.checked) }} /> {copy.autoInstall}</label>
        <div className="component-picks">
          {components.map(component => (
            <label key={component.id}>
              <input type="checkbox" checked={picked.includes(component.id)} onChange={event => { setPicked(event.target.checked ? [...picked, component.id] : picked.filter(id => id !== component.id)) }} />
              <span><strong>{componentText(active, component).name}</strong><em className="muted">{componentText(active, component).summary}</em></span>
            </label>
          ))}
        </div>
        <div className="row">
          <button className="secondary" type="button" disabled={secret.trim() === ''} onClick={() => { void preview() }}>{copy.testConnection}</button>
          <button className="primary" type="submit" disabled={busy}>{copy.save}</button>
        </div>
      </form>
    </Panel>
  )
}

function ServerDetail(props: { active: string; id: string; onEdit: () => void; onTerminal: () => void; onBack: () => void }) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [server, setServer] = useState<ServerRow | undefined>()
  const [error, setError] = useState<ServerError | null>(null)
  const [queued, setQueued] = useState(false)

  useEffect(() => {
    let stopped = false
    const load = () => {
      void api<ServerRow>(`/console-api/servers/${props.id}`).then(next => {
        if (!stopped) setServer(next)
      }).catch((cause: unknown) => {
        if (!stopped) setError(requestError(cause))
      })
    }
    load()
    const timer = setInterval(load, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [props.id])

  async function act(path: string): Promise<void> {
    setError(null)
    setQueued(false)
    try {
      await api(path, { method: 'POST' })
      setQueued(true)
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

  if (server === undefined) return <Panel title={copy.server}><p className="muted">{error === null ? copy.loading : displayError(active, error)}</p></Panel>
  const missing = Object.values(server.component_status).some(item => item.installed === false)
  const containers = server.containers ?? []
  const containerNote = server.reachability === 'unknown' ? copy.notTested : containers.length === 0 ? copy.containerRefresh : ''
  return (
    <Panel title={server.name} extra={<button className="link" type="button" onClick={props.onBack}>{copy.back}</button>}>
      {error !== null ? <p className="banner error">{displayError(active, error)}</p> : null}
      {queued ? <p className="banner ok">{copy.jobQueued}</p> : null}
      <div className="node-card">
        <div className="node-title"><span className="name-text">{server.intranet_host}:{server.ssh_port}</span><span className={`pill ${server.reachability}`}>{enumLabel(serverCopy(active).reach, server.reachability)}</span></div>
        <div className="node-grid">
          <div><span>{copy.user}</span>{server.ssh_user}</div>
          <div><span>{copy.region}</span>{server.region || '—'}</div>
          <div><span>Docker</span>{server.docker_version || '—'}</div>
          <div><span>Compose</span>{server.compose_version || '—'}</div>
          <div><span>{copy.hostFingerprint}</span><b className="mono">{server.host_key_fingerprint || copy.notPinned}</b></div>
        </div>
        <div className="node-actions">
          <button className="secondary" type="button" onClick={() => { void act(`/console-api/servers/${server.id}/test`) }}>{copy.testConnection}</button>
          <button className="secondary" type="button" onClick={() => { void act(`/console-api/servers/${server.id}/inspect`) }}>{copy.refresh}</button>
          {missing ? <button className="secondary" type="button" onClick={() => { void act(`/console-api/servers/${server.id}/install-components`) }}>{copy.installComponents}</button> : null}
          <button className="secondary" type="button" onClick={props.onTerminal}>{copy.terminal}</button>
          <button className="secondary" type="button" onClick={props.onEdit}>{copy.edit}</button>
          <button className="link danger" type="button" onClick={() => { void remove() }}>{copy.delete}</button>
        </div>
      </div>
      <h2>{copy.components}</h2>
      <ul>{Object.entries(server.component_status).map(([id, item]) => <li key={id}>{componentName(active, id)}: {item.installed ? copy.installed : copy.notInstalled} {item.detail ?? ''}</li>)}</ul>
      <h2>{copy.containers}</h2>
      {containerNote !== '' ? <p className="empty">{containerNote}</p> : (
        <table>
          <thead><tr><th>{copy.name}</th><th>{copy.image}</th><th>{copy.status}</th><th>{copy.ports}</th></tr></thead>
          <tbody>{containers.map(item => <tr key={item.container_id}><td>{item.name}</td><td>{item.image}</td><td><span className={`pill ${item.status}`}>{enumLabel(serverCopy(active).containerStatus, item.status)}</span></td><td>{item.ports}</td></tr>)}</tbody>
        </table>
      )}
      <h2>{copy.jobs}</h2>
      <ul>{(server.jobs ?? []).map(job => <li key={job.id}>{enumLabel(serverCopy(active).actions, job.action)} <span className={`pill ${job.status}`}>{enumLabel(serverCopy(active).jobStatus, job.status)}</span> {job.output_excerpt}</li>)}</ul>
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
    const socket = new WebSocket(`${proto}//${location.host}/console-api/servers/terminal?id=${encodeURIComponent(props.id)}`)
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (event) => {
      const chunk = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
      setText(current => `${current}${chunk}`.slice(-20000))
    }
    socket.onerror = () => { setError(new ServerError('terminal_failed')) }
    const host = document.querySelector('.terminal-host')
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
      const key = event.key === 'Enter' ? '\r' : event.key === 'Backspace' ? '\u007f' : event.key === 'Tab' ? '\t' : event.key.length === 1 ? event.key : ''
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
    <Panel title={copy.terminal} extra={<button className="link" type="button" onClick={props.onBack}>{copy.back}</button>}>
      {error !== null ? <p className="banner error">{displayError(active, error)}</p> : null}
      <div className="terminal-page">
        <pre className="terminal-host" tabIndex={0} style={{ color: '#f2f3f5', whiteSpace: 'pre-wrap', margin: 0 }}>{text || copy.terminalHint}</pre>
      </div>
    </Panel>
  )
}

function meter(percent: number | null, label: string): string {
  if (percent === null || !Number.isFinite(percent)) return '—'
  return `${Math.round(percent)}% ${label === '%' ? '' : label}`.trim()
}

function ratio(used: number | string | null, total: number | string | null): number | null {
  const left = Number(used)
  const right = Number(total)
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return null
  return Math.max(0, Math.min(100, 100 * left / right))
}

function bytes(value: number | string | null): string {
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
