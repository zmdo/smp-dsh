import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Panel } from '@smp/console-kit'
import { api } from './api.ts'
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

const REACH: Record<string, string> = {
  online: '在线',
  offline: '离线',
  docker_unavailable: 'Docker 不可用',
  unknown: '未知',
}

export function ServersPage() {
  const [screen, setScreen] = useState<Screen>('list')
  const [serverId, setServerId] = useState('')
  const [editing, setEditing] = useState(false)
  const [listView, setListView] = useState<ListView>({ groupId: null, query: '', page: 1, pageSize: 10 })
  if (screen === 'form') {
    return <ServerForm editing={editing} serverId={serverId} initialGroupId={listView.groupId ?? ''} onDone={(id) => { setServerId(id); setScreen(id === '' ? 'list' : 'detail') }} onCancel={() => { setScreen(serverId === '' ? 'list' : 'detail') }} />
  }
  if (screen === 'detail') return <ServerDetail id={serverId} onEdit={() => { setEditing(true); setScreen('form') }} onTerminal={() => { setScreen('terminal') }} onBack={() => { setScreen('list') }} />
  if (screen === 'terminal') return <ServerTerminal id={serverId} onBack={() => { setScreen('detail') }} />
  return <ServerList view={listView} onView={setListView} onOpen={(id) => { setServerId(id); setEditing(false); setScreen('detail') }} onCreate={() => { setServerId(''); setEditing(false); setScreen('form') }} />
}

function ServerList(props: { view: ListView; onView: (view: ListView) => void; onOpen: (id: string) => void; onCreate: () => void }) {
  const [servers, setServers] = useState<ServerRow[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [groupError, setGroupError] = useState('')
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
        setLoadError('')
      }).catch((cause: unknown) => {
        if (!stopped && version === dataVersion.current) setLoadError(cause instanceof Error ? cause.message : '请求没有完成')
      }).finally(() => { loading = false })
    }
    load()
    const timer = setInterval(load, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  const { view, onView } = props
  const groupId = loaded && view.groupId && !groups.some(group => group.id === view.groupId) ? null : view.groupId
  const groupLabel = groupId === null ? '全部服务器' : groupId === '' ? '未分组' : groups.find(group => group.id === groupId)?.name ?? ''
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
    setActionError('')
  }

  async function createGroup(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (creatingGroup) return
    setCreatingGroup(true)
    setGroupError('')
    try {
      const group = await api<GroupRow>('/console-api/server-groups', { method: 'POST', body: JSON.stringify({ name: groupName }) })
      dataVersion.current += 1
      setGroups(current => [...current, group].sort((a, b) => a.name.localeCompare(b.name)))
      selectGroup(group.id)
      setGroupName('')
      setAddingGroup(false)
    } catch (cause) {
      setGroupError(cause instanceof Error ? cause.message : '请求没有完成')
    } finally {
      setCreatingGroup(false)
    }
  }

  async function removeGroup(id: string): Promise<void> {
    setActionError('')
    try {
      await api(`/console-api/server-groups/${id}`, { method: 'DELETE' })
      dataVersion.current += 1
      setGroups(current => current.filter(group => group.id !== id))
      setServers(current => current.map(server => server.group_id === id ? { ...server, group_id: null, group_name: null } : server))
      if (groupId === id) selectGroup('')
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '请求没有完成')
    }
  }

  async function move(id: string, groupId: string): Promise<void> {
    setActionError('')
    try {
      const saved = await api<ServerRow>(`/console-api/servers/${id}`, { method: 'PATCH', body: JSON.stringify({ group_id: groupId === '' ? null : groupId }) })
      dataVersion.current += 1
      setServers(current => current.map(server => server.id === id ? saved : server))
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '请求没有完成')
    }
  }

  return (
    <div className="smp-server-shell">
      <aside className="smp-server-sidebar">
        <header className="smp-server-group-head">
          <h2>分组</h2>
          <button className="link" type="button" aria-expanded={addingGroup} onClick={() => { setAddingGroup(!addingGroup); setGroupError('') }}>＋ 新建分组</button>
        </header>
        {addingGroup && (
          <form className="smp-server-group-form" onSubmit={event => { void createGroup(event) }}>
            <input aria-label="分组名" placeholder="分组名" value={groupName} maxLength={80} required autoFocus disabled={creatingGroup} onChange={event => { setGroupName(event.target.value) }} />
            {groupError !== '' && <p className="smp-server-group-error" role="alert">{groupError}</p>}
            <div className="row">
              <button className="primary" type="submit" disabled={creatingGroup || groupName.trim() === ''}>创建</button>
              <button className="secondary" type="button" disabled={creatingGroup} onClick={() => { setAddingGroup(false); setGroupName(''); setGroupError('') }}>取消</button>
            </div>
          </form>
        )}
        <nav className="smp-server-groups" aria-label="服务器分组">
          <GroupChoice label="全部服务器" count={servers.length} selected={groupId === null} onSelect={() => selectGroup(null)} />
          {groups.map(group => (
            <GroupChoice key={group.id} label={group.name} count={servers.filter(server => server.group_id === group.id).length} selected={groupId === group.id} onSelect={() => selectGroup(group.id)} onDelete={() => { void removeGroup(group.id) }} />
          ))}
          <GroupChoice label="未分组" count={servers.filter(server => server.group_id === null).length} selected={groupId === ''} onSelect={() => selectGroup('')} />
        </nav>
      </aside>
      <div className="smp-server-main">
        <Panel title={<>服务器实例<span className="smp-server-current-group">{groupLabel}</span></>} extra={
          <div className="row smp-server-tools">
            <input type="search" className="search" aria-label="搜索服务器" value={view.query} placeholder="搜索服务器" onChange={event => { onView({ ...view, query: event.target.value, page: 1 }) }} />
            <button className="primary" type="button" onClick={props.onCreate}>登记服务器</button>
          </div>
        }>
          {(actionError || loadError) !== '' && <p className="banner error" role="alert">{actionError || loadError}</p>}
          <div className="table-wrap smp-server-table-scroll" ref={tableScroll}>
            <table className="clickable smp-server-table" aria-label="服务器实例">
              <thead>
                <tr><th>名称</th><th>地址</th><th>区域</th><th>可达状态</th><th>CPU</th><th>内存</th><th>硬盘</th><th>Docker</th><th>容器数</th><th>最近检查</th><th>分组</th></tr>
              </thead>
              <tbody>
                {rows.map(server => <ServerLine key={server.id} server={server} groups={groups} onOpen={props.onOpen} onMove={(id, groupId) => { void move(id, groupId) }} />)}
              </tbody>
            </table>
            {rows.length === 0 && <p className="smp-server-empty">{!loaded ? loadError ? '暂时无法读取服务器' : '正在读取服务器' : view.query.trim() !== '' ? '没有匹配的服务器' : groupId === null ? '还没有登记服务器' : '这一组还没有服务器'}</p>}
          </div>
          <footer className="smp-server-pager" aria-label="服务器分页">
            <span>共 {filtered.length} 台{filtered.length > 0 ? `，第 ${(page - 1) * view.pageSize + 1}–${Math.min(page * view.pageSize, filtered.length)} 台` : ''}</span>
            <div className="row">
              <label>每页 <select aria-label="每页服务器数量" value={view.pageSize} onChange={event => { onView({ ...view, pageSize: Number(event.target.value), page: 1 }) }}>{[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}</select> 台</label>
              <button className="secondary" type="button" disabled={page === 1} onClick={() => { onView({ ...view, page: page - 1 }) }}>上一页</button>
              <span aria-live="polite">第 {page} / {pages} 页</span>
              <button className="secondary" type="button" disabled={page === pages} onClick={() => { onView({ ...view, page: page + 1 }) }}>下一页</button>
            </div>
          </footer>
        </Panel>
      </div>
    </div>
  )
}

function GroupChoice(props: { label: string; count: number; selected: boolean; onSelect: () => void; onDelete?: () => void }) {
  return (
    <div className={`smp-server-group${props.selected ? ' is-on' : ''}`}>
      <button className="smp-server-group-choice" type="button" aria-current={props.selected ? 'true' : undefined} onClick={props.onSelect} title={props.label}>
        <span>{props.label}</span><span className="smp-server-group-count">{props.count}</span>
      </button>
      {props.onDelete && <button className="smp-server-group-delete" type="button" aria-label={`删除分组「${props.label}」`} title="删除分组" onClick={props.onDelete}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6 4.5V2.8h4v1.7M4.5 4.5l.6 9h5.8l.6-9M6.5 7v4M9.5 7v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>}
    </div>
  )
}

function ServerLine(props: { server: ServerRow; groups: GroupRow[]; onOpen: (id: string) => void; onMove: (id: string, groupId: string) => void }) {
  const { server } = props
  return (
    <tr onClick={() => { props.onOpen(server.id) }}>
      <td><button className="smp-server-open" type="button" onClick={event => { event.stopPropagation(); props.onOpen(server.id) }}>{server.name}</button></td>
      <td className="mono">{server.intranet_host}:{server.ssh_port}</td>
      <td>{server.region || '—'}</td>
      <td><span className={`pill ${server.reachability}`}>{REACH[server.reachability] ?? server.reachability}</span></td>
      <td>{meter(server.cpu_percent, '%')}</td>
      <td>{meter(ratio(server.mem_used_bytes, server.mem_total_bytes), bytes(server.mem_used_bytes))}</td>
      <td>{meter(ratio(server.disk_used_bytes, server.disk_total_bytes), bytes(server.disk_used_bytes))}</td>
      <td>{server.docker_version || '—'}</td>
      <td>{server.container_count}</td>
      <td className="nowrap">{when(server.last_checked_at)}</td>
      <td onClick={event => { event.stopPropagation() }}>
        <select className="group-pick" aria-label={`${server.name} 的分组`} value={server.group_id ?? ''} onChange={event => { props.onMove(server.id, event.target.value) }}>
          <option value="">未分组</option>
          {props.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </td>
    </tr>
  )
}

function ServerForm(props: { editing: boolean; serverId: string; initialGroupId: string; onDone: (id: string) => void; onCancel: () => void }) {
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
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
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
    }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : '请求没有完成') })
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
    }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : '请求没有完成') })
  }, [props.editing, props.serverId])

  async function preview(): Promise<void> {
    setError('')
    setNote('')
    try {
      const result = await api<{ ok: boolean; fingerprint?: string; detail?: string }>('/console-api/servers/test-connection', {
        method: 'POST',
        body: JSON.stringify({ intranet_host: host, ssh_port: Number(port), ssh_user: user, auth_method: method, secret }),
      })
      setNote(result.ok ? `已连通。指纹 ${result.fingerprint}` : (result.detail ?? '连接测试失败'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求没有完成')
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError('')
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
      setError(cause instanceof Error ? cause.message : '请求没有完成')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title={props.editing ? '编辑服务器' : '登记服务器'} extra={<button className="link" type="button" onClick={props.onCancel}>返回</button>}>
      {error !== '' ? <p className="banner error">{error}</p> : null}
      {note !== '' ? <p className="banner ok">{note}</p> : null}
      <form className="panel-form" onSubmit={event => { void save(event) }}>
        <label className="field">名称<input value={name} onChange={event => { setName(event.target.value) }} /></label>
        <div className="triple">
          <label className="field">内网地址<input value={host} onChange={event => { setHost(event.target.value) }} /></label>
          <label className="field">端口<input value={port} onChange={event => { setPort(event.target.value) }} /></label>
          <label className="field">用户<input value={user} onChange={event => { setUser(event.target.value) }} /></label>
        </div>
        <label className="field">认证方式
          <select value={method} onChange={event => { setMethod(event.target.value) }}>
            <option value="private_key">私钥</option>
            <option value="password">口令</option>
          </select>
        </label>
        {method === 'private_key' ? (
          <>
            <label className="field">已有密钥
              <select value={keyId} onChange={event => { setKeyId(event.target.value) }}>
                <option value="">不选择</option>
                {keys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}
              </select>
            </label>
            <label className="field">新密钥名称<input value={keyName} onChange={event => { setKeyName(event.target.value) }} /></label>
            <label className="field">粘贴私钥<textarea value={secret} onChange={event => { setSecret(event.target.value) }} placeholder="只在提交时发送" /></label>
          </>
        ) : <label className="field">口令<input type="password" value={secret} onChange={event => { setSecret(event.target.value) }} /></label>}
        <div className="triple">
          <label className="field">分组
            <select value={groupId} onChange={event => { setGroupId(event.target.value) }}>
              <option value="">未分组</option>
              {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </label>
          <label className="field">区域<input value={region} onChange={event => { setRegion(event.target.value) }} placeholder="留空则自动填写" /></label>
        </div>
        <label><input type="checkbox" checked={auto} onChange={event => { setAuto(event.target.checked) }} /> 自动安装所选组件</label>
        <div className="component-picks">
          {components.map(component => (
            <label key={component.id}>
              <input type="checkbox" checked={picked.includes(component.id)} onChange={event => { setPicked(event.target.checked ? [...picked, component.id] : picked.filter(id => id !== component.id)) }} />
              <span><strong>{component.name}</strong><em className="muted">{component.summary}</em></span>
            </label>
          ))}
        </div>
        <div className="row">
          <button className="secondary" type="button" disabled={secret.trim() === ''} onClick={() => { void preview() }}>连接测试</button>
          <button className="primary" type="submit" disabled={busy}>保存</button>
        </div>
      </form>
    </Panel>
  )
}

function ServerDetail(props: { id: string; onEdit: () => void; onTerminal: () => void; onBack: () => void }) {
  const [server, setServer] = useState<ServerRow | undefined>()
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    let stopped = false
    const load = () => {
      void api<ServerRow>(`/console-api/servers/${props.id}`).then(next => {
        if (!stopped) setServer(next)
      }).catch((cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : '请求没有完成')
      })
    }
    load()
    const timer = setInterval(load, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [props.id])

  async function act(path: string): Promise<void> {
    setError('')
    setNote('')
    try {
      await api(path, { method: 'POST' })
      setNote('任务已排上')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求没有完成')
    }
  }

  async function remove(): Promise<void> {
    try {
      await api(`/console-api/servers/${props.id}`, { method: 'DELETE' })
      props.onBack()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求没有完成')
    }
  }

  if (server === undefined) return <Panel title="服务器"><p className="muted">{error || '正在读取'}</p></Panel>
  const missing = Object.values(server.component_status).some(item => item.installed === false)
  const containers = server.containers ?? []
  const containerNote = server.reachability === 'unknown' ? '尚未测试连接' : containers.length === 0 ? '在线后每 30 秒自动刷新' : ''
  return (
    <Panel title={server.name} extra={<button className="link" type="button" onClick={props.onBack}>返回</button>}>
      {error !== '' ? <p className="banner error">{error}</p> : null}
      {note !== '' ? <p className="banner ok">{note}</p> : null}
      <div className="node-card">
        <div className="node-title"><span className="name-text">{server.intranet_host}:{server.ssh_port}</span><span className={`pill ${server.reachability}`}>{REACH[server.reachability] ?? server.reachability}</span></div>
        <div className="node-grid">
          <div><span>用户</span>{server.ssh_user}</div>
          <div><span>区域</span>{server.region || '—'}</div>
          <div><span>Docker</span>{server.docker_version || '—'}</div>
          <div><span>Compose</span>{server.compose_version || '—'}</div>
          <div><span>主机指纹</span><b className="mono">{server.host_key_fingerprint || '尚未钉住'}</b></div>
        </div>
        <div className="node-actions">
          <button className="secondary" type="button" onClick={() => { void act(`/console-api/servers/${server.id}/test`) }}>测试连接</button>
          <button className="secondary" type="button" onClick={() => { void act(`/console-api/servers/${server.id}/inspect`) }}>立即刷新</button>
          {missing ? <button className="secondary" type="button" onClick={() => { void act(`/console-api/servers/${server.id}/install-components`) }}>安装必要组件</button> : null}
          <button className="secondary" type="button" onClick={props.onTerminal}>终端</button>
          <button className="secondary" type="button" onClick={props.onEdit}>编辑</button>
          <button className="link danger" type="button" onClick={() => { void remove() }}>删除</button>
        </div>
      </div>
      <h2>组件</h2>
      <ul>{Object.entries(server.component_status).map(([id, item]) => <li key={id}>{id}：{item.installed ? '已安装' : '未安装'} {item.detail ?? ''}</li>)}</ul>
      <h2>容器</h2>
      {containerNote !== '' ? <p className="empty">{containerNote}</p> : (
        <table>
          <thead><tr><th>名称</th><th>镜像</th><th>状态</th><th>端口</th></tr></thead>
          <tbody>{containers.map(item => <tr key={item.container_id}><td>{item.name}</td><td>{item.image}</td><td><span className={`pill ${item.status}`}>{item.status}</span></td><td>{item.ports}</td></tr>)}</tbody>
        </table>
      )}
      <h2>任务</h2>
      <ul>{(server.jobs ?? []).map(job => <li key={job.id}>{job.action} <span className={`pill ${job.status}`}>{job.status}</span> {job.output_excerpt}</li>)}</ul>
    </Panel>
  )
}

function ServerTerminal(props: { id: string; onBack: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${proto}//${location.host}/console-api/servers/terminal?id=${encodeURIComponent(props.id)}`)
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (event) => {
      const chunk = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
      setText(current => `${current}${chunk}`.slice(-20000))
    }
    socket.onerror = () => { setError('终端没有连上') }
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
    <Panel title="终端" extra={<button className="link" type="button" onClick={props.onBack}>返回</button>}>
      {error !== '' ? <p className="banner error">{error}</p> : null}
      <div className="terminal-page">
        <pre className="terminal-host" tabIndex={0} style={{ color: '#f2f3f5', whiteSpace: 'pre-wrap', margin: 0 }}>{text || '点击这里，然后输入。'}</pre>
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

function when(value: string | null): string {
  if (value === null || value === '') return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}
