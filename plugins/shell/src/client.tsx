import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { consoleCss } from '@smp/console-kit'
import { navGroups, pageLabel, pageRoutes, type NavGroup, type RegisteredPage } from './pages.ts'
import { createSection, type SectionStore } from './section.ts'
import { shellCopy, type ShellCopy } from './copy.ts'
import { GeneralView, type LocaleFace, type ThemeFace } from './general-view.tsx'
import { SecurityView } from './security-view.tsx'
import { loadSiteChrome } from './site-chrome.ts'

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
  slots: PageSlots
  layout: Layout
  sessions: Sessions
  uiWorkspace: Workspace
  workspaces: Workspaces
  locale: LocaleFace
  theme: ThemeFace
  on(name: 'theme/change', listener: () => void): () => void
  effect(run: () => (() => void)): void
}

interface PageSlots {
  entries(key: string): readonly RegisteredPage[]
  subscribe(key: string, listener: () => void): () => void
  inject(name: string, register: () => () => void): void
  register(options: object, component: unknown): () => void
}

interface RenderSlot {
  (name: string, props: object, options: { entryKey?: string; fallback?: ReactNode }): ReactNode
}

const CONSOLE_PANEL = 'console'
const SECURITY_PAGE = 'settings'
const GENERAL_PAGE = 'general'
const PLATFORM_GROUP = 'platform'

const SHELL_STYLE = `
.smp-shell, .smp-console {
  --smp-text: var(--dsw-alias-label-primary); --smp-muted: var(--dsw-alias-label-tertiary); --smp-line: var(--dsw-alias-border-l2);
  --smp-primary: var(--dsw-alias-state-business-primary); --smp-primary-soft: var(--dsw-specific-sidebar-nav-item-active);
  color: var(--smp-text);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.5;
}
.smp-shell { height: 100%; display: flex; flex-direction: column; background: var(--dsw-specific-sidebar-fill); overflow: hidden; }
.smp-shell.is-collapsed { align-items: center; padding-top: 14px; }
.smp-shell .logo { height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 16px; font-size: 15px; font-weight: 650; color: var(--smp-text); }
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
  text-align: left; color: var(--smp-text); border-radius: 4px; position: relative;
}
.smp-shell .nav-item { height: 40px; padding: 0 12px; }
.smp-shell .nav-item:hover, .smp-shell .nav-sub-item:hover, .smp-shell .session-row:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
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
.smp-shell .session-new, .smp-shell .session-row { height: 32px; padding: 0 10px; color: var(--dsw-alias-label-secondary); }
.smp-shell .session-row.is-on { color: var(--smp-primary); font-weight: 600; }
.smp-shell .session-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smp-shell .session-empty { margin: 4px 10px; color: var(--smp-muted); font-size: 12px; }
.smp-console {
  --text: var(--smp-text); --muted: var(--smp-muted); --line: var(--smp-line); --border: var(--dsw-alias-border-l3);
  --primary: var(--smp-primary); --primary-soft: var(--dsw-alias-state-business-tertiary);
  --green: var(--dsw-alias-state-success-primary); --green-bg: var(--dsw-alias-state-success-tertiary);
  --red: var(--dsw-alias-state-error-primary); --red-bg: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);
  --warn: var(--dsw-alias-state-warn-label); --warn-bg: var(--dsw-alias-state-warn-tertiary); --bg: var(--dsw-alias-bg-base);
  height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--bg);
}
.smp-console .topbar {
  height: 48px; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--smp-line);
  display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 20px; flex: none;
}
.smp-console .tabs { display: flex; height: 100%; gap: 4px; }
.smp-console .tab { display: flex; align-items: center; height: 100%; padding: 0 14px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); }
.smp-console .tab.is-on { color: var(--smp-primary); box-shadow: inset 0 -2px 0 var(--smp-primary); }
.smp-console .content { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px 28px; }
`

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

function useCopy(locale: LocaleFace): ShellCopy {
  const snap = useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot())
  return shellCopy(snap.active)
}

function sessionLabel(row: SessionRow, copy: ShellCopy): string {
  if (row.displayTitle !== undefined && row.displayTitle !== '') return row.displayTitle
  if (row.title !== undefined && row.title !== '') return row.title
  if (row.cwd !== undefined && row.cwd !== '') {
    const base = row.cwd.split('/').filter(part => part !== '').pop()
    if (base !== undefined && base !== '') return base
  }
  return copy.untitled
}

function SessionListView(props: {
  sessions: Sessions
  copy: ShellCopy
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
      <button className="session-new" type="button" onClick={props.startSession}>{props.copy.newSession}</button>
      {rows.length === 0 && <p className="session-empty">{snap.phase === 'ready' ? props.copy.noSessions : props.copy.loadingSessions}</p>}
      {rows.map(row => (
        <button
          key={row.sessionId}
          className={`session-row${picked === row.sessionId ? ' is-on' : ''}`}
          type="button"
          onClick={() => { setPicked(row.sessionId); props.openSession(row.sessionId) }}
        >
          <span>{sessionLabel(row, props.copy)}</span>
        </button>
      ))}
    </div>
  )
}

function usePages(slots: PageSlots, locale: LocaleFace): ReturnType<typeof pageRoutes> {
  const entries = useSyncExternalStore(
    listener => slots.subscribe('console.page', listener),
    () => slots.entries('console.page'),
  )
  useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot())
  return pageRoutes(entries)
}

function groupOf(pages: ReturnType<typeof pageRoutes>, key: string): NavGroup | undefined {
  const groups = navGroups(pages)
  return groups.nav.concat(groups.footer).find(group => group.pages.some(page => page.key === key))
}

function ShellSidebar(props: {
  slots: PageSlots
  locale: LocaleFace
  section: SectionStore
  collapsed: boolean
  openConsole: (id: string) => void
  openConversation: () => void
  toggleSidebar: () => void
  sessions: Sessions
  startSession: () => void
  openSession: (id: string) => void
  usePanelInfo?: (select: (info: { activePanelId: string | null }) => string | null) => string | null
}) {
  const current = useSyncExternalStore(props.section.subscribe, props.section.get)
  const pages = usePages(props.slots, props.locale)
  const copy = useCopy(props.locale)
  const groups = navGroups(pages)
  const panelId = props.usePanelInfo?.(info => info.activePanelId)
  const onConversation = panelId === null
  useEffect(() => {
    if (pages.some(page => page.key === current)) return
    const fallback = pages.find(page => page.key === SECURITY_PAGE) ?? pages[0]
    if (fallback !== undefined) props.section.set(fallback.key)
  }, [pages, current, props.section])

  if (props.collapsed) {
    return (
      <div className="smp-shell is-collapsed">
        <button className="rail-mark" type="button" aria-label={copy.expand} onClick={props.toggleSidebar}>策</button>
      </div>
    )
  }

  return (
    <div className="smp-shell">
      <div className="logo"><span className="logo-mark">策</span><span>{copy.console}</span></div>
      <nav className="nav">
        <button className={`nav-item${onConversation ? ' is-on' : ''}`} type="button" onClick={props.openConversation}>{copy.advisor}</button>
        {onConversation && (
          <SessionListView sessions={props.sessions} copy={copy} openSession={props.openSession} startSession={props.startSession} />
        )}
        {groups.nav.map(group => (
          <button
            key={group.id}
            className={`nav-item${!onConversation && group.pages.some(page => page.key === current) ? ' is-on' : ''}`}
            type="button"
            onClick={() => {
              const first = group.pages[0]
              if (first !== undefined) props.openConsole(first.key)
            }}
          >
            {group.label}
          </button>
        ))}
      </nav>
      {groups.footer.length > 0 && (
        <div className="nav-foot">
          {groups.footer.map(group => (
            <button
              key={group.id}
              className={`nav-item${!onConversation && group.pages.some(page => page.key === current) ? ' is-on' : ''}`}
              type="button"
              onClick={() => {
                const first = group.pages[0]
                if (first !== undefined) props.openConsole(first.key)
              }}
            >
              {group.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LoginRedirect() {
  window.location.replace('/login')
  return null
}

function ConsolePanel(props: { slots: PageSlots; locale: LocaleFace; section: SectionStore; auth: AuthStore; renderSlot?: RenderSlot }) {
  const current = useSyncExternalStore(props.section.subscribe, props.section.get)
  const auth = useSyncExternalStore(props.auth.subscribe, props.auth.get)
  const pages = usePages(props.slots, props.locale)
  const copy = useCopy(props.locale)
  const tabs = groupOf(pages, current)?.pages ?? []
  const body = props.renderSlot?.('console.page', {}, { entryKey: current }) ?? null
  return (
    <div className="smp-console">
      {auth.authenticated && (
        <header className="topbar">
          <nav className="tabs">
            {tabs.map(page => (
              <button key={page.key} className={`tab${page.key === current ? ' is-on' : ''}`} type="button" onClick={() => props.section.set(page.key)}>
                {page.label}
              </button>
            ))}
          </nav>
          <button className="link" type="button" onClick={() => { void props.auth.logout().then(() => { window.location.assign('/login') }) }}>{copy.logout}</button>
        </header>
      )}
      <div className="content">
        {auth.checked && auth.authenticated && (
          <>
            {auth.passwordIsDefault && <p className="banner">{copy.banner}</p>}
            {props.renderSlot?.('console.settings-host', { page: current })}
            {body}
          </>
        )}
        {auth.checked && !auth.authenticated ? <LoginRedirect /> : null}
      </div>
    </div>
  )
}

export const inject = ['slots', 'layout', 'sessions', 'uiWorkspace', 'workspaces', 'locale', 'theme']

export function apply(ctx: ShellCtx): void {
  const section = createSection()
  const auth = createAuth()
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@smp/console-shell'
    tag.textContent = SHELL_STYLE + consoleCss
    document.head.appendChild(tag)
    void auth.refresh()
    loadSiteChrome()
    return () => { tag.remove() }
  })
  const openConsole = (id: string): void => {
    section.set(id)
    ctx.layout.selectPanel(CONSOLE_PANEL)
  }
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    priority: -100,
    inject: () => ({
      slots: ctx.slots,
      locale: ctx.locale,
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
        'console.settings-host': { kind: 'single', scope: 'root' },
      },
    }, (props: { renderSlot?: RenderSlot }) => <ConsolePanel slots={ctx.slots} locale={ctx.locale} section={section} auth={auth} renderSlot={props.renderSlot} />)
    ctx.layout.selectPanel(CONSOLE_PANEL)
    return dispose
  })
  const theme: ThemeFace = {
    getTheme: () => ctx.theme.getTheme(),
    setTheme: (id) => { ctx.theme.setTheme(id) },
    subscribe: (listener) => ctx.on('theme/change', listener),
  }
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: SECURITY_PAGE,
    label: pageLabel(() => shellCopy(ctx.locale.getSnapshot().active).security, {
      group: PLATFORM_GROUP,
      groupLabel: () => shellCopy(ctx.locale.getSnapshot().active).platform,
      placement: 'footer',
    }),
    order: 5,
  }, () => <SecurityView auth={auth} locale={ctx.locale} />))
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: GENERAL_PAGE,
    label: pageLabel(() => shellCopy(ctx.locale.getSnapshot().active).general, {
      group: PLATFORM_GROUP,
      groupLabel: () => shellCopy(ctx.locale.getSnapshot().active).platform,
      placement: 'footer',
    }),
    order: 0,
  }, () => <GeneralView locale={ctx.locale} theme={theme} />))
}
