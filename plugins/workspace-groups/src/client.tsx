import { focusedWorkspace, sessionWorkspaceGroup } from './rules.ts'
import { groupCopy } from './copy.ts'
import { GroupStore, type GroupSnapshot } from './store.ts'

interface LocaleFace {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

interface ListFace<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SessionRow {
  id: string
  cwd?: string
  retainedBy?: { mainView?: number }
}

interface WorkspaceItem {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
}

interface WorkspaceList {
  items: readonly WorkspaceItem[]
}

interface WorkspacesApi {
  list: ListFace<WorkspaceList>
}

interface SessionsApi {
  list: ListFace<{ byId: Record<string, SessionRow> }>
}

interface UiWorkspaceApi {
  openWorkspace(workspaceId: string): Promise<void>
}

interface LayoutApi {
  selectPanel(id: string | null): void
}

interface GroupApi {
  subscribe(listener: () => void): () => void
  getSnapshot(): GroupSnapshot
  selectedId(): string
  hiddenPages(): string[]
  select(groupId: string): void
  refresh(): Promise<void>
}

interface ClientCtx {
  workspaces: WorkspacesApi
  uiWorkspace: UiWorkspaceApi
  locale: LocaleFace
  sessions: SessionsApi
  layout: LayoutApi
  reflect: { provide(name: string, value: unknown): unknown }
  effect(run: () => (() => void)): void
}

const STYLE = `
.smp-chat-side { position: relative; }
.smp-group-switch {
  position: absolute;
  z-index: 2;
  top: 8px;
  left: 8px;
  max-width: 45%;
  height: 28px;
  display: flex;
  align-items: center;
}
.smp-group-switch select {
  width: auto;
  max-width: 100%;
  margin: 0;
  padding: 0 14px 0 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.smp-chat-side .smp-group-label-covered { visibility: hidden !important; }
.smp-chat-side:has([class*="sectionLabelHidden"]) .smp-group-switch { visibility: hidden; }
`

export const inject = ['workspaces', 'uiWorkspace', 'locale', 'sessions', 'layout']

export function apply(ctx: ClientCtx): void {
  const store = new GroupStore(ctx.sessions.list, ctx.workspaces.list)
  const api: GroupApi = {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    selectedId: store.selectedId,
    hiddenPages: store.hiddenPages,
    select: (groupId) => { store.select(groupId) },
    refresh: () => loadGroups(store),
  }
  ctx.reflect.provide('workspaceGroups', api)
  void loadGroups(store)
  ctx.effect(() => store.watch())
  ctx.effect(() => installStyle())
  ctx.effect(() => installSwitch(store, api, ctx))
}

function installStyle(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@smp/console-workspace-groups'
  tag.textContent = STYLE
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

function chatSide(): HTMLElement | null {
  return document.querySelector('.smp-chat-side')
}

function installSwitch(store: GroupStore, api: GroupApi, ctx: ClientCtx): () => void {
  const wrap = document.createElement('div')
  wrap.className = 'smp-group-switch'
  const select = document.createElement('select')
  select.setAttribute('aria-label', groupCopy(ctx.locale.getSnapshot().active).group)
  wrap.append(select)
  wrap.hidden = true
  let placed: HTMLElement | null = null
  let claiming = false
  let postedFocus = ''

  const place = (): void => {
    const side = chatSide()
    if (side === null) return
    if (placed !== side) {
      side.prepend(wrap)
      placed = side
    }
  }

  const sync = (): void => {
    place()
    const snapshot = store.getSnapshot()
    paint(snapshot, store.selectedId())
    const side = chatSide()
    const covered = side?.querySelector('.smp-group-label-covered')
    wrap.hidden = snapshot.groups.length === 0 || covered === null
    fillSelect(select, snapshot, store.selectedId())
    if (claiming || snapshot.groups.length === 0) return
    const known = new Set(snapshot.members.map(row => row.workspaceId))
    const missing = ctx.workspaces.list.getSnapshot().items.filter(item => !known.has(item.workspaceId))
    if (missing.length > 0) {
      claiming = true
      void claimAll(store, missing.map(item => item.workspaceId), store.selectedId()).finally(() => { claiming = false })
      return
    }
    postedFocus = rememberFocus(store, ctx.sessions, ctx.workspaces, postedFocus)
  }

  select.addEventListener('change', () => { void enter(ctx, api, select.value) })
  const stopStore = store.subscribe(sync)
  const stopWorkspaces = ctx.workspaces.list.subscribe(sync)
  const stopSessions = ctx.sessions.list.subscribe(sync)
  const observer = new MutationObserver(sync)
  let watching: HTMLElement | null = null
  const attach = (): void => {
    const side = chatSide()
    if (side === null || side === watching) return
    observer.disconnect()
    watching = side
    observer.observe(side, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  }
  const body = new MutationObserver(() => { attach(); sync() })
  body.observe(document.body, { childList: true, subtree: true })
  attach()
  sync()
  return () => {
    stopStore()
    stopWorkspaces()
    stopSessions()
    observer.disconnect()
    body.disconnect()
    wrap.remove()
  }
}

function fillSelect(select: HTMLSelectElement, snapshot: GroupSnapshot, selectedId: string): void {
  const signature = `${selectedId}|${snapshot.groups.map(group => `${group.id}:${group.label}`).join(',')}`
  if (select.dataset.signature === signature) return
  select.replaceChildren()
  for (const group of snapshot.groups) {
    const option = document.createElement('option')
    option.value = group.id
    option.textContent = group.label
    select.append(option)
  }
  if (snapshot.groups.some(group => group.id === selectedId)) select.value = selectedId
  select.dataset.signature = signature
}

function paint(snapshot: GroupSnapshot, selectedId: string): void {
  const side = chatSide()
  if (side === null) return
  const ready = snapshot.groups.length > 0
  const allowed = new Set(snapshot.members.filter(row => row.groupId === selectedId).map(row => row.workspaceId))
  for (const label of side.querySelectorAll<HTMLElement>('[class*="sectionLabel"]')) {
    const text = label.textContent?.trim() ?? ''
    label.classList.toggle('smp-group-label-covered', text === '工作区' || text === 'Workspaces')
  }
  for (const section of side.querySelectorAll<HTMLElement>('[class*="groupSection"]')) {
    const row = section.querySelector('[data-row-key^="workspace:"]')
    const workspaceId = row?.getAttribute('data-row-key')?.slice('workspace:'.length) ?? ''
    section.hidden = ready && workspaceId !== '' && !allowed.has(workspaceId)
  }
}

async function enter(ctx: ClientCtx, api: GroupApi, groupId: string): Promise<void> {
  api.select(groupId)
  const snapshot = api.getSnapshot()
  const items = ctx.workspaces.list.getSnapshot().items
  if (sessionWorkspaceGroup(ctx.sessions.list.getSnapshot(), [...items], snapshot.members) === groupId) return
  const target = focusedWorkspace(snapshot.members, groupId, snapshot.focus.find(row => row.groupId === groupId)?.workspaceId)
  if (target === undefined) return
  await ctx.uiWorkspace.openWorkspace(target)
  ctx.layout.selectPanel(null)
  await postGroup('/console-api/workspace-groups/focus', { groupId, workspaceId: target })
  await api.refresh()
}

async function claimAll(store: GroupStore, workspaceIds: readonly string[], groupId: string): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await postGroup('/console-api/workspace-groups/claim', { workspaceId, groupId })
  }
  await loadGroups(store)
}

function rememberFocus(store: GroupStore, sessions: SessionsApi, workspaces: WorkspacesApi, posted: string): string {
  const items = workspaces.list.getSnapshot().items
  const members = store.getSnapshot().members
  const groupId = sessionWorkspaceGroup(sessions.list.getSnapshot(), [...items], members)
  if (groupId === undefined) return posted
  const main = Object.values(sessions.list.getSnapshot().byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)
  const item = main === undefined ? undefined : items.find(workspace => workspace.sessionIds.includes(main.id) || (main.cwd !== undefined && main.cwd !== '' && workspace.path === main.cwd))
  if (item === undefined || members.find(row => row.workspaceId === item.workspaceId)?.groupId !== groupId) return posted
  const key = `${groupId}:${item.workspaceId}`
  if (posted === key || store.getSnapshot().focus.find(row => row.groupId === groupId)?.workspaceId === item.workspaceId) return key
  void postGroup('/console-api/workspace-groups/focus', { groupId, workspaceId: item.workspaceId }).then(() => loadGroups(store))
  return key
}

async function loadGroups(store: GroupStore): Promise<void> {
  const response = await fetch('/console-api/workspace-groups', { credentials: 'include' })
  if (!response.ok) return
  const body = await response.json() as Partial<GroupSnapshot>
  if (!Array.isArray(body.groups) || !Array.isArray(body.members) || !Array.isArray(body.focus) || !Array.isArray(body.allows)) return
  store.replace({ groups: body.groups, members: body.members, focus: body.focus, allows: body.allows })
}

async function postGroup(path: string, body: { workspaceId: string; groupId: string }): Promise<string> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { detail?: unknown }
  if (!response.ok) return typeof payload.detail === 'string' ? payload.detail : '没有完成'
  return ''
}
