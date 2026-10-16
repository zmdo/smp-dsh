import { useState, useSyncExternalStore, type ReactNode } from 'react'
import contentCss from './content.css'
import { createSection, type SectionId, type SectionStore } from './section.ts'

interface Layout {
  selectPanel(id: string | null): void
  toggleSidebar(): void
}

interface SessionRow {
  title?: string
  displayTitle?: string
  cwd?: string
  sessionId: string
  updatedAt: number
  blank: boolean
  origin?: string
}

interface Sessions {
  list: {
    getSnapshot(): { ids: string[]; byId: Record<string, SessionRow>; phase: string }
    subscribe(listener: () => void): () => void
  }
}

interface Workspace {
  startSession(workspaceId?: string): void
  openSession(id: string): void
}

interface Workspaces {
  list: { getSnapshot(): { items: { workspaceId: string }[] } }
  initializeDefault(): Promise<{ workspaceId: string } | undefined>
}

interface AuthSnap {
  checked: boolean
  authenticated: boolean
  username: string | null
  passwordIsDefault: boolean
  totpEnabled: boolean
}

interface AuthStore {
  get(): AuthSnap
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  logout(): Promise<void>
}

interface ShellCtx {
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: object, component: unknown): () => void
  }
  layout: Layout
  sessions: Sessions
  uiWorkspace: Workspace
  workspaces: Workspaces
  effect(run: () => (() => void)): void
}

interface RenderSlot {
  (name: string, props: object, options: { entryKey?: string; fallback?: ReactNode }): ReactNode
}

const CONSOLE_PANEL = 'console'

const SECTION_LABEL: Record<SectionId, string> = {
  dashboard: '仪表盘',
  'quant-overview': '概览',
  'quant-markets': '行情',
  'quant-exchanges': '交易所',
  'quant-strategies': '交易策略',
  wallet: '钱包实例',
  cards: '虚拟信用卡',
  servers: '服务器实例',
  keys: '服务器密钥',
  settings: '登录安全',
  mcp: 'MCP',
}

const QUANT_TABS: SectionId[] = ['quant-overview', 'quant-markets', 'quant-exchanges', 'quant-strategies']
const SERVER_TABS: SectionId[] = ['servers', 'keys']
const SETTINGS_TABS: SectionId[] = ['settings', 'mcp']

const SHELL_STYLE = `
.smp-shell, .smp-console {
  --smp-text: #323232; --smp-muted: #8a8f99; --smp-line: #e8eaed;
  --smp-primary: #005eeb; --smp-primary-soft: #eef4ff;
  color: var(--smp-text);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.5;
}
.smp-shell { height: 100%; display: flex; flex-direction: column; background: #fff; overflow: hidden; }
.smp-shell.is-collapsed { align-items: center; padding-top: 14px; }
.smp-shell .logo { height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 16px; font-size: 15px; font-weight: 650; color: #1f2329; }
.smp-shell .logo-mark, .smp-shell .rail-mark {
  width: 28px; height: 28px; border-radius: 6px; background: var(--smp-primary); color: #fff;
  display: grid; place-items: center; font-size: 14px; font-weight: 700; border: 0; padding: 0;
}
.smp-shell .nav { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 8px 10px; gap: 2px; overflow: auto; }
.smp-shell .nav-title { margin: 16px 12px 4px; color: var(--smp-muted); font-size: 12px; font-weight: 600; }
.smp-shell .nav-title:first-child { margin-top: 8px; }
.smp-shell .nav-foot { margin-top: auto; padding: 8px 10px 12px; border-top: 1px solid var(--smp-line); }
.smp-shell .nav-item, .smp-shell .nav-sub-item, .smp-shell .session-row, .smp-shell .session-new {
  display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent;
  text-align: left; color: #3c4048; border-radius: 4px; position: relative;
}
.smp-shell .nav-item { height: 40px; padding: 0 12px; }
.smp-shell .nav-item:hover, .smp-shell .nav-sub-item:hover, .smp-shell .session-row:hover { background: #f5f7fa; }
.smp-shell .nav-item.is-on { background: var(--smp-primary-soft); color: var(--smp-primary); font-weight: 600; }
.smp-shell .nav-item.is-on::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--smp-primary);
}
.smp-shell .nav-caret { margin-left: auto; }
.smp-shell .nav-group.is-open .nav-caret { transform: rotate(90deg); }
.smp-shell .nav-sub { display: flex; flex-direction: column; gap: 2px; padding: 0 0 4px 26px; }
.smp-shell .nav-sub-item { height: 34px; padding: 0 12px; }
.smp-shell .nav-sub-item.is-on { color: var(--smp-primary); font-weight: 600; background: var(--smp-primary-soft); }
.smp-shell .sessions { display: flex; flex-direction: column; gap: 2px; padding: 0 0 6px 18px; min-height: 0; }
.smp-shell .session-new, .smp-shell .session-row { height: 32px; padding: 0 10px; color: #4e5460; }
.smp-shell .session-row.is-on { color: var(--smp-primary); font-weight: 600; }
.smp-shell .session-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smp-shell .session-empty { margin: 4px 10px; color: var(--smp-muted); font-size: 12px; }
.smp-console {
  --text: var(--smp-text); --muted: var(--smp-muted); --line: var(--smp-line); --border: #dcdfe6;
  --primary: var(--smp-primary); --primary-soft: var(--smp-primary-soft);
  --green: #1f9d55; --green-bg: #e8f7ee; --red: #e5484d; --red-bg: #fdecec;
  --warn: #d4880f; --warn-bg: #fff6e5; --bg: #f4f6f8;
  height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--bg);
}
.smp-console .topbar {
  height: 48px; background: #fff; border-bottom: 1px solid var(--smp-line);
  display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 20px; flex: none;
}
.smp-console .tabs { display: flex; height: 100%; gap: 4px; }
.smp-console .tab { display: flex; align-items: center; height: 100%; padding: 0 14px; border: 0; background: transparent; color: #4e5460; }
.smp-console .tab.is-on { color: var(--smp-primary); box-shadow: inset 0 -2px 0 var(--smp-primary); }
.smp-console .content { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px 28px; }
.smp-console .panel { background: #fff; border: 1px solid var(--smp-line); border-radius: 4px; }
.smp-console .panel-head { min-height: 48px; display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--smp-line); }
.smp-console .panel-head h1 { margin: 0; font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.smp-console .mark { width: 3px; height: 14px; border-radius: 1px; background: var(--smp-primary); }
.smp-console .empty { margin: 0; padding: 28px 16px; color: var(--smp-muted); }
`

function tabsFor(id: SectionId): SectionId[] {
  if (QUANT_TABS.includes(id)) return QUANT_TABS
  if (id === 'wallet') return ['wallet']
  if (id === 'cards') return ['cards']
  if (SERVER_TABS.includes(id)) return SERVER_TABS
  if (SETTINGS_TABS.includes(id)) return SETTINGS_TABS
  return ['dashboard']
}

function createAuth(): AuthStore {
  let snap: AuthSnap = {
    checked: false,
    authenticated: false,
    username: null,
    passwordIsDefault: false,
    totpEnabled: false,
  }
  const listeners = new Set<() => void>()
  const publish = (next: AuthSnap): void => {
    snap = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh() {
      try {
        const response = await fetch('/console-api/auth/me', { credentials: 'include' })
        const me = await response.json() as {
          authenticated?: boolean
          username?: string | null
          password_is_default?: boolean
          totp_enabled?: boolean
        }
        publish({
          checked: true,
          authenticated: me.authenticated === true,
          username: typeof me.username === 'string' ? me.username : null,
          passwordIsDefault: me.password_is_default === true,
          totpEnabled: me.totp_enabled === true,
        })
      } catch (error) {
        // A failed status check leaves the page logged out.
        void error
        publish({ checked: true, authenticated: false, username: null, passwordIsDefault: false, totpEnabled: false })
      }
    },
    async logout() {
      await fetch('/console-api/auth/logout', { method: 'POST', credentials: 'include' })
      publish({ checked: true, authenticated: false, username: null, passwordIsDefault: false, totpEnabled: false })
    },
  }
}

function sessionLabel(row: SessionRow): string {
  if (row.displayTitle !== undefined && row.displayTitle !== '') return row.displayTitle
  if (row.title !== undefined && row.title !== '') return row.title
  if (row.cwd !== undefined && row.cwd !== '') {
    const base = row.cwd.split('/').filter(part => part !== '').pop()
    if (base !== undefined && base !== '') return base
  }
  return '未命名会话'
}

function SessionListView(props: {
  sessions: Sessions
  openSession: (id: string) => void
  startSession: () => void
}) {
  const snap = useSyncExternalStore(props.sessions.list.subscribe, props.sessions.list.getSnapshot)
  const [picked, setPicked] = useState<string | null>(null)
  const rows = snap.ids
    .map(id => snap.byId[id])
    .filter((row): row is SessionRow => row !== undefined && row.origin !== 'subagent')
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <div className="sessions">
      <button className="session-new" type="button" onClick={props.startSession}>新会话</button>
      {rows.length === 0 && <p className="session-empty">{snap.phase === 'ready' ? '还没有会话' : '会话加载中'}</p>}
      {rows.map(row => (
        <button
          key={row.sessionId}
          className={`session-row${picked === row.sessionId ? ' is-on' : ''}`}
          type="button"
          onClick={() => { setPicked(row.sessionId); props.openSession(row.sessionId) }}
        >
          <span>{sessionLabel(row)}</span>
        </button>
      ))}
    </div>
  )
}

function ShellSidebar(props: {
  section: SectionStore
  collapsed: boolean
  openConsole: (id: SectionId) => void
  openConversation: () => void
  toggleSidebar: () => void
  sessions: Sessions
  startSession: () => void
  openSession: (id: string) => void
  usePanelInfo?: (select: (info: { activePanelId: string | null }) => string | null) => string | null
}) {
  const current = useSyncExternalStore(props.section.subscribe, props.section.get)
  const panelId = props.usePanelInfo?.(info => info.activePanelId)
  const onConversation = panelId === null
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  function toggleGroup(name: string, first: SectionId) {
    if (openGroup === name) { setOpenGroup(null); return }
    setOpenGroup(name)
    const inGroup = name === 'quant'
      ? QUANT_TABS.includes(current)
      : name === 'accounts'
        ? current === 'wallet' || current === 'cards'
        : false
    if (!inGroup) props.openConsole(first)
  }

  if (props.collapsed) {
    return (
      <div className="smp-shell is-collapsed">
        <button className="rail-mark" type="button" aria-label="展开侧栏" onClick={props.toggleSidebar}>策</button>
      </div>
    )
  }

  const quantOpen = openGroup === 'quant'
  const accountsOpen = openGroup === 'accounts'
  return (
    <div className="smp-shell">
      <div className="logo"><span className="logo-mark">策</span><span>策略控制台</span></div>
      <nav className="nav">
        <p className="nav-title">概览</p>
        <button className={`nav-item${!onConversation && current === 'dashboard' ? ' is-on' : ''}`} type="button" onClick={() => { setOpenGroup(null); props.openConsole('dashboard') }}>仪表盘</button>
        <button className={`nav-item${onConversation ? ' is-on' : ''}`} type="button" onClick={() => { setOpenGroup(null); props.openConversation() }}>军师</button>
        {onConversation && (
          <SessionListView sessions={props.sessions} openSession={props.openSession} startSession={props.startSession} />
        )}
        <p className="nav-title">运营</p>
        <div className={`nav-group${quantOpen ? ' is-open' : ''}`}>
          <button className="nav-item" type="button" onClick={() => toggleGroup('quant', 'quant-overview')}>
            量化交易
            <svg className="nav-caret" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M4.2 2.4 7.8 6 4.2 9.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {quantOpen && (
            <div className="nav-sub">
              <button className={`nav-sub-item${!onConversation && QUANT_TABS.includes(current) ? ' is-on' : ''}`} type="button" onClick={() => props.openConsole('quant-overview')}>数字货币</button>
            </div>
          )}
        </div>
        <p className="nav-title">资源</p>
        <div className={`nav-group${accountsOpen ? ' is-open' : ''}`}>
          <button className="nav-item" type="button" onClick={() => toggleGroup('accounts', 'wallet')}>
            资金账户
            <svg className="nav-caret" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M4.2 2.4 7.8 6 4.2 9.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {accountsOpen && (
            <div className="nav-sub">
              <button className={`nav-sub-item${!onConversation && current === 'wallet' ? ' is-on' : ''}`} type="button" onClick={() => props.openConsole('wallet')}>数字钱包</button>
              <button className={`nav-sub-item${!onConversation && current === 'cards' ? ' is-on' : ''}`} type="button" onClick={() => props.openConsole('cards')}>信用卡</button>
            </div>
          )}
        </div>
        <button className={`nav-item${!onConversation && SERVER_TABS.includes(current) ? ' is-on' : ''}`} type="button" onClick={() => { setOpenGroup(null); props.openConsole('servers') }}>服务器</button>
      </nav>
      <div className="nav-foot">
        <button className={`nav-item${!onConversation && SETTINGS_TABS.includes(current) ? ' is-on' : ''}`} type="button" onClick={() => { setOpenGroup(null); props.openConsole('settings') }}>平台设置</button>
      </div>
    </div>
  )
}

function LoginRedirect() {
  window.location.replace('/login')
  return null
}

function ConsolePanel(props: { section: SectionStore; auth: AuthStore; renderSlot?: RenderSlot }) {
  const current = useSyncExternalStore(props.section.subscribe, props.section.get)
  const auth = useSyncExternalStore(props.auth.subscribe, props.auth.get)
  const tabs = tabsFor(current)
  const body = props.renderSlot?.('console.page', {}, { entryKey: current }) ?? null
  return (
    <div className="smp-console">
      {auth.authenticated && (
        <header className="topbar">
          <nav className="tabs">
            {tabs.map(id => (
              <button key={id} className={`tab${id === current ? ' is-on' : ''}`} type="button" onClick={() => props.section.set(id)}>
                {SECTION_LABEL[id]}
              </button>
            ))}
          </nav>
          <button className="link" type="button" onClick={() => { void props.auth.logout().then(() => { window.location.assign('/login') }) }}>退出</button>
        </header>
      )}
      <div className="content">
        {auth.checked && auth.authenticated && (
          <>
            {auth.passwordIsDefault && <p className="banner">当前仍是默认用户名 admin、密码 changeme。请到「平台设置 / 登录安全」里修改。</p>}
            {body}
          </>
        )}
        {auth.checked && !auth.authenticated ? <LoginRedirect /> : null}
      </div>
    </div>
  )
}

export const inject = ['slots', 'layout', 'sessions', 'uiWorkspace', 'workspaces']

export function apply(ctx: ShellCtx): void {
  const section = createSection()
  const auth = createAuth()
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@smp/console-shell'
    tag.textContent = SHELL_STYLE + contentCss
    document.head.appendChild(tag)
    void auth.refresh()
    return () => { tag.remove() }
  })
  const openConsole = (id: SectionId): void => {
    section.set(id)
    ctx.layout.selectPanel(CONSOLE_PANEL)
  }
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    priority: -100,
    inject: () => ({
      section,
      openConsole,
      openConversation: () => { ctx.layout.selectPanel(null) },
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
      sessions: ctx.sessions,
      startSession: () => {
        ctx.layout.selectPanel(null)
        const existing = ctx.workspaces.list.getSnapshot().items[0]?.workspaceId
        if (existing !== undefined) {
          ctx.uiWorkspace.startSession(existing)
          return
        }
        void ctx.workspaces.initializeDefault().then(prepared => {
          if (prepared !== undefined) ctx.uiWorkspace.startSession(prepared.workspaceId)
        })
      },
      openSession: (id: string) => {
        ctx.layout.selectPanel(null)
        ctx.uiWorkspace.openSession(id)
      },
    }),
  }, ShellSidebar))
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: CONSOLE_PANEL,
      children: {
        'console.page': { kind: 'keyed', scope: 'root' },
      },
    }, (props: { renderSlot?: RenderSlot }) => <ConsolePanel section={section} auth={auth} renderSlot={props.renderSlot} />)
    ctx.layout.selectPanel(CONSOLE_PANEL)
    return dispose
  })
}
