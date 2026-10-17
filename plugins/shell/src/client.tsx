import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { consoleCss } from '@smp/console-kit'
import { navGroups, pageLabel, pageRoutes, visibleGroups, type NavGroup, type RegisteredPage } from './pages.ts'
import { createSection, type SectionStore } from './section.ts'
import { shellCopy, type ShellCopy } from './copy.ts'
import { GeneralView, type LocaleFace, type ThemeFace } from './general-view.tsx'
import { SecurityView } from './security-view.tsx'
import { createSiteStore, type SiteStore } from './site-chrome.ts'
import { CONVERSATION_ID, menuChoices, sidebarBlocks, type PlacedOption } from './menu.ts'
import { createMenuStore, type MenuStore } from './menu-store.ts'
import { MenuView } from './menu-view.tsx'

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
const MENU_PAGE = 'menu'
const PLATFORM_GROUP = 'platform'
const AGENT_GROUP = 'agent'
const EVOLUTION_GROUP = 'evolution'
const AGENT_CHAT = 'agent-chat'
const AGENT_ARCHIVE = 'agent-archive'
const EVOLUTION_CHAT = 'evolution-chat'
const EVOLUTION_LINES = 'evolution-lines'
const EVOLUTION_SETTINGS = 'evolution-settings'

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
.smp-shell .logo { height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 16px; font-size: 15px; font-weight: 650; color: var(--smp-text); }
.smp-shell .logo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smp-shell .fold {
  width: 20px; height: 20px; margin-left: auto; border: 0; border-radius: 4px; background: transparent;
  color: var(--smp-muted); display: grid; place-items: center; padding: 0; flex: none; cursor: pointer;
}
.smp-shell .fold .nav-glyph, .smp-shell .rail-expand .nav-glyph { width: 20px; height: 20px; }
.smp-shell .fold:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--smp-text); }
.smp-shell .nav-glyph { width: 18px; height: 18px; flex: none; display: block; }
.smp-shell .rail { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; width: 100%; min-height: 0; padding: 8px 0 12px; }
.smp-shell .rail-foot { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.smp-shell .rail-item {
  width: 40px; height: 40px; border: 0; border-radius: 6px; background: transparent; color: var(--smp-text);
  display: grid; place-items: center; padding: 0; cursor: pointer;
}
.smp-shell .rail-item.is-on { background: var(--smp-primary-soft); color: var(--smp-primary); }
.smp-shell .logo-mark, .smp-shell .rail-mark {
  width: 20px; height: 20px; border-radius: 6px; background: var(--smp-primary); color: #fff;
  display: grid; place-items: center; font-size: 14px; font-weight: 700; border: 0; padding: 0;
}
.smp-shell .logo-mark.has-icon, .smp-shell .rail-mark.has-icon { background: transparent; color: var(--smp-text); }
.smp-shell .rail-mark { cursor: pointer; }
.smp-shell .logo-mark img, .smp-shell .rail-mark img { width: 20px; height: 20px; display: block; object-fit: contain; }
.smp-shell .rail-expand { display: none; }
.smp-shell .rail-mark:hover, .smp-shell .rail-mark:focus-visible { background: var(--dsw-specific-sidebar-nav-item-hover); }
.smp-shell .rail-mark:hover .rail-logo, .smp-shell .rail-mark:focus-visible .rail-logo { display: none; }
.smp-shell .rail-mark:hover .rail-expand, .smp-shell .rail-mark:focus-visible .rail-expand { display: grid; }
.smp-shell .mark-dark { display: none; }
body[data-ds-dark-theme] .smp-shell .mark-light { display: none; }
body[data-ds-dark-theme] .smp-shell .mark-dark { display: block; }
.smp-shell .nav { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 8px 10px; gap: 2px; overflow: auto; }
.smp-shell .nav-title { margin: 16px 12px 4px; color: var(--smp-muted); font-size: 13px; font-weight: 600; }
.smp-shell .nav > .menu-block:first-child .nav-title, .smp-shell .nav-foot > .menu-block:first-child .nav-title { margin-top: 8px; }
.smp-console .menu-create { display: flex; gap: 8px; max-width: 440px; margin: 12px 0; }
.smp-console .menu-create input { flex: 1; }
.smp-console .menu-board { display: grid; gap: 12px; }
.smp-console .menu-group { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px 12px; }
.smp-console .menu-group.is-over { border-color: var(--dsw-alias-state-business-primary); }
.smp-console .menu-group header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-weight: 600; }
.smp-console .menu-item { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; margin-bottom: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); cursor: grab; }
.smp-console .menu-grip { width: 10px; height: 14px; background: radial-gradient(circle, var(--dsw-alias-label-tertiary) 1px, transparent 1.5px) 0 0 / 5px 5px; }
.smp-console .menu-empty { margin: 0; color: var(--dsw-alias-label-tertiary); }
.smp-shell .nav-foot { margin-top: auto; padding: 8px 10px 12px; border-top: 1px solid var(--smp-line); }
.smp-shell .nav-item, .smp-shell .nav-sub-item, .smp-shell .session-row, .smp-shell .session-new {
  display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: transparent;
  text-align: left; color: var(--smp-text); border-radius: 4px; position: relative;
}
.smp-shell .nav-item { height: 44px; padding: 0 12px; font-size: 14px; }
.smp-shell .nav-item:hover, .smp-shell .nav-sub-item:hover, .smp-shell .session-row:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
.smp-shell .nav-item.is-on { background: var(--smp-primary-soft); color: var(--smp-primary); font-weight: 600; }
.smp-shell .nav-item.is-on::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--smp-primary);
}
.smp-shell .nav-group { display: flex; flex-direction: column; }
.smp-shell .nav-head { display: flex; align-items: center; }
.smp-shell .nav-head .nav-item { flex: 1; min-width: 0; }
.smp-shell .nav-caret {
  width: 28px; height: 28px; margin-right: 4px; border: 0; border-radius: 4px; background: transparent;
  color: var(--smp-muted); display: grid; place-items: center; padding: 0; cursor: pointer; flex: none;
}
.smp-shell .nav-caret::before {
  content: ""; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg); margin-left: -2px;
}
.smp-shell .nav-caret:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--smp-text); }
.smp-shell .nav-group.is-open .nav-caret { transform: rotate(90deg); }
.smp-shell .nav-sub { display: flex; flex-direction: column; gap: 2px; padding: 0 0 4px 26px; }
.smp-shell .nav-sub-item { height: 34px; padding: 0 12px; font-size: 14px; }
.smp-shell .nav-sub-item.is-on { color: var(--smp-primary); font-weight: 600; background: var(--smp-primary-soft); }
.smp-shell .sessions, .smp-chat-side .sessions { display: flex; flex-direction: column; gap: 2px; min-height: 0; }
.smp-shell .session-new, .smp-shell .session-row, .smp-chat-side .session-new, .smp-chat-side .session-row {
  height: 32px; padding: 0 10px; color: var(--dsw-alias-label-secondary);
  display: flex; align-items: center; width: 100%; border: 0; background: transparent; text-align: left; border-radius: 4px; cursor: pointer;
}
.smp-chat-side .session-row:hover, .smp-chat-side .session-new:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
.smp-shell .session-row.is-on, .smp-chat-side .session-row.is-on { color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.smp-shell .session-row span, .smp-chat-side .session-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smp-shell .session-empty, .smp-chat-side .session-empty { margin: 4px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
[data-phase]:has(.smp-chat-side) { padding-left: 240px; }
.smp-chat-side {
  position: absolute; left: 0; top: 0; bottom: 0; width: 240px; z-index: 4; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 4px; padding: 8px; overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-specific-sidebar-fill);
  color: var(--dsw-alias-label-primary);
}
.smp-chat-tabs { display: flex; align-items: center; gap: 2px; height: 32px; }
.smp-chat-tabs button {
  height: 32px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.smp-chat-tabs button.is-on { color: var(--dsw-alias-state-business-primary); box-shadow: inset 0 -2px 0 var(--dsw-alias-state-business-primary); }
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

function NavGlyph(props: { name: string }) {
  const common = { className: 'nav-glyph', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }
  if (props.name === 'robot') {
    return (
      <svg {...common}>
        <path d="M8 1.8v1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="8" cy="1.8" r="0.7" fill="currentColor" />
        <rect x="3" y="4" width="10" height="7.4" rx="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6.2" cy="7.4" r="0.8" fill="currentColor" />
        <circle cx="9.8" cy="7.4" r="0.8" fill="currentColor" />
        <path d="M6.2 9.4h3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  if (props.name === 'settings') {
    return (
      <svg {...common}>
        <path d="M2.8 4.2h10.4M2.8 8h10.4M2.8 11.8h10.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="5.4" cy="4.2" r="1.5" fill="currentColor" />
        <circle cx="10.6" cy="8" r="1.5" fill="currentColor" />
        <circle cx="6.6" cy="11.8" r="1.5" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <rect x="3" y="3" width="10" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function FoldIcon() {
  return (
    <svg className="nav-glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.4" y="3" width="11.2" height="10" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}
function BrandMark(props: { icon: string }) {
  if (props.icon !== '') return <img src={props.icon} alt="" />
  return (
    <>
      <img className="mark-light" src="/favicon.svg" alt="" />
      <img className="mark-dark" src="/favicon-dark.svg" alt="" />
    </>
  )
}

function ShellSidebar(props: {
  slots: PageSlots
  locale: LocaleFace
  section: SectionStore
  site: SiteStore
  menu: MenuStore
  collapsed: boolean
  openConsole: (id: string) => void
  toggleSidebar: () => void
  usePanelInfo?: (select: (info: { activePanelId: string | null }) => string | null) => string | null
}) {
  const current = useSyncExternalStore(props.section.subscribe, props.section.get)
  const pages = usePages(props.slots, props.locale)
  const copy = useCopy(props.locale)
  const site = useSyncExternalStore(props.site.subscribe, props.site.get)
  const saved = useSyncExternalStore(props.menu.subscribe, props.menu.get)
  const [harnessOpen, setHarnessOpen] = useState(true)
  const groups = navGroups(pages)
  const listed = visibleGroups(groups)
  const byId = new Map(listed.nav.concat(listed.footer).map(group => [group.id, group]))
  const blocks = sidebarBlocks(menuChoices(listed, copy.advisor), saved, copy.overview)
  const panelId = props.usePanelInfo?.(info => info.activePanelId)
  const onConversation = panelId === null
  const harnessOn = current === AGENT_CHAT || current === AGENT_ARCHIVE || current === EVOLUTION_CHAT || current === EVOLUTION_LINES || current === EVOLUTION_SETTINGS
  useEffect(() => {
    if (pages.some(page => page.key === current)) return
    const fallback = pages.find(page => page.key === SECURITY_PAGE) ?? pages[0]
    if (fallback !== undefined) props.section.set(fallback.key)
  }, [pages, current, props.section])

  const openItem = (item: PlacedOption): void => {
    if (item.id === CONVERSATION_ID) {
      setHarnessOpen(true)
      props.openConsole(AGENT_CHAT)
      return
    }
    const first = byId.get(item.id)?.pages[0]
    if (first !== undefined) props.openConsole(first.key)
  }
  const itemOn = (item: PlacedOption): boolean => {
    if (item.id === CONVERSATION_ID) return harnessOn
    return !onConversation && (byId.get(item.id)?.pages.some(page => page.key === current) ?? false)
  }

  if (props.collapsed) {
    return (
      <div className="smp-shell is-collapsed">
        <button className="rail-mark has-icon" type="button" aria-label={copy.expand} onClick={props.toggleSidebar}>
          <span className="rail-logo"><BrandMark icon={site.icon} /></span>
          <span className="rail-expand"><FoldIcon /></span>
        </button>
        <div className="rail">
          {blocks.map(block => block.items.map(item => (
            <RailChoice key={item.id} item={item} on={itemOn(item)} onOpen={() => openItem(item)} />
          )))}
          <div className="rail-foot">
            {groups.footer.map(group => (
              <RailChoice key={group.id} item={{ id: group.id, label: group.label, placement: 'nav', order: group.order, icon: group.icon, section: '' }} on={!onConversation && group.pages.some(page => page.key === current)} onOpen={() => { const first = group.pages[0]; if (first !== undefined) props.openConsole(first.key) }} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="smp-shell">
      <div className="logo">
        <span className="logo-mark has-icon"><BrandMark icon={site.icon} /></span>
        <span className="logo-name">{site.title}</span>
        <button className="fold" type="button" aria-label={copy.collapse} onClick={props.toggleSidebar}><FoldIcon /></button>
      </div>
      <nav className="nav">
        {blocks.map(block => (
          <div className="menu-block" key={block.id}>
            {block.title !== '' && <div className="nav-title">{block.title}</div>}
            {block.items.map(item => item.id === CONVERSATION_ID ? (
              <div className={`nav-group${harnessOpen ? ' is-open' : ''}`} key={item.id}>
                <div className="nav-head">
                  <button className="nav-item" type="button" onClick={() => openItem(item)}>
                    <NavGlyph name={item.icon === '' ? 'box' : item.icon} />
                    <span>{item.label}</span>
                  </button>
                  <button className="nav-caret" type="button" aria-expanded={harnessOpen} aria-label={copy.advisor} onClick={() => setHarnessOpen(open => !open)} />
                </div>
                {harnessOpen && (
                  <div className="nav-sub">
                    <button className={`nav-sub-item${current === AGENT_CHAT || current === AGENT_ARCHIVE ? ' is-on' : ''}`} type="button" onClick={() => props.openConsole(AGENT_CHAT)}>{copy.agentSessions}</button>
                    <button className={`nav-sub-item${current === EVOLUTION_CHAT || current === EVOLUTION_LINES || current === EVOLUTION_SETTINGS ? ' is-on' : ''}`} type="button" onClick={() => props.openConsole(EVOLUTION_CHAT)}>{copy.evolution}</button>
                  </div>
                )}
              </div>
            ) : (
              <OptionButton key={item.id} item={item} on={itemOn(item)} onOpen={() => openItem(item)} />
            ))}
          </div>
        ))}
      </nav>
      {groups.footer.length > 0 && (
        <div className="nav-foot">
          {groups.footer.map(group => (
            <OptionButton
              key={group.id}
              item={{ id: group.id, label: group.label, placement: 'nav', order: group.order, icon: group.icon, section: '' }}
              on={!onConversation && group.pages.some(page => page.key === current)}
              onOpen={() => {
                const first = group.pages[0]
                if (first !== undefined) props.openConsole(first.key)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function OptionButton(props: { item: PlacedOption; on: boolean; onOpen: () => void }) {
  return (
    <button className={`nav-item${props.on ? ' is-on' : ''}`} type="button" onClick={props.onOpen}>
      <NavGlyph name={props.item.icon === '' ? 'box' : props.item.icon} />
      <span>{props.item.label}</span>
    </button>
  )
}

function RailChoice(props: { item: PlacedOption; on: boolean; onOpen: () => void }) {
  return (
    <button
      className={`rail-item${props.on ? ' is-on' : ''}`}
      type="button"
      aria-label={props.item.label}
      title={props.item.label}
      onClick={props.onOpen}
    >
      <NavGlyph name={props.item.icon === '' ? 'box' : props.item.icon} />
    </button>
  )
}

function LoginRedirect() {
  window.location.replace('/login')
  return null
}

function ConversationChrome(props: {
  locale: LocaleFace
  openConsole: (id: string) => void
  sessions: Sessions
  startSession: () => void
  openSession: (id: string) => void
}) {
  const copy = useCopy(props.locale)
  return (
    <>
      <nav className="smp-chat-tabs" aria-label={copy.agentSessions}>
        <button className="is-on" type="button" onClick={() => props.openConsole(AGENT_CHAT)}>{copy.chat}</button>
        <button type="button" onClick={() => props.openConsole(AGENT_ARCHIVE)}>{copy.archive}</button>
      </nav>
      <aside className="smp-chat-side">
        <SessionListView sessions={props.sessions} copy={copy} openSession={props.openSession} startSession={props.startSession} />
      </aside>
    </>
  )
}

function EmptyPage() {
  return null
}

function ConsolePanel(props: { slots: PageSlots; locale: LocaleFace; section: SectionStore; auth: AuthStore; openConsole: (id: string) => void; renderSlot?: RenderSlot }) {
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
              <button key={page.key} className={`tab${page.key === current ? ' is-on' : ''}`} type="button" onClick={() => props.openConsole(page.key)}>
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
  const site = createSiteStore()
  const menu = createMenuStore()
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@smp/console-shell'
    tag.textContent = SHELL_STYLE + consoleCss
    document.head.appendChild(tag)
    void auth.refresh()
    void site.refresh().catch((cause: unknown) => { void cause })
    void menu.refresh().catch((cause: unknown) => { void cause })
    return () => { tag.remove() }
  })
  const openConsole = (id: string): void => {
    section.set(id)
    ctx.layout.selectPanel(id === AGENT_CHAT ? null : CONSOLE_PANEL)
  }
  const startSession = (): void => {
    openConsole(AGENT_CHAT)
    const existing = ctx.workspaces.list.getSnapshot().items[0]?.workspaceId
    if (existing !== undefined) {
      ctx.uiWorkspace.startSession(existing)
      return
    }
    void ctx.workspaces.initializeDefault().then(prepared => {
      if (prepared !== undefined) ctx.uiWorkspace.startSession(prepared.workspaceId)
    })
  }
  const openSession = (id: string): void => {
    openConsole(AGENT_CHAT)
    ctx.uiWorkspace.openSession(id)
  }
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    priority: -100,
    inject: () => ({
      slots: ctx.slots,
      locale: ctx.locale,
      section,
      openConsole,
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
      site,
      menu,
    }),
  }, ShellSidebar))
  ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
    name: 'conversation.header.leading',
    inject: () => ({
      locale: ctx.locale,
      openConsole,
      sessions: ctx.sessions,
      startSession,
      openSession,
    }),
  }, ConversationChrome))
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: CONSOLE_PANEL,
      children: {
        'console.page': { kind: 'keyed', scope: 'root' },
        'console.settings-host': { kind: 'single', scope: 'root' },
      },
    }, (props: { renderSlot?: RenderSlot }) => <ConsolePanel slots={ctx.slots} locale={ctx.locale} section={section} auth={auth} openConsole={openConsole} renderSlot={props.renderSlot} />)
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
      icon: 'settings',
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
      icon: 'settings',
    }),
    order: 0,
  }, () => <GeneralView locale={ctx.locale} theme={theme} site={site} />))
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: MENU_PAGE,
    label: pageLabel(() => shellCopy(ctx.locale.getSnapshot().active).menu, {
      group: PLATFORM_GROUP,
      groupLabel: () => shellCopy(ctx.locale.getSnapshot().active).platform,
      placement: 'footer',
      icon: 'settings',
    }),
    order: 2,
  }, () => <MenuView slots={ctx.slots} locale={ctx.locale} menu={menu} />))
  registerNested(ctx, AGENT_CHAT, () => shellCopy(ctx.locale.getSnapshot().active).chat, AGENT_GROUP, () => shellCopy(ctx.locale.getSnapshot().active).agentSessions, 0)
  registerNested(ctx, AGENT_ARCHIVE, () => shellCopy(ctx.locale.getSnapshot().active).archive, AGENT_GROUP, () => shellCopy(ctx.locale.getSnapshot().active).agentSessions, 1)
  registerNested(ctx, EVOLUTION_CHAT, () => shellCopy(ctx.locale.getSnapshot().active).chat, EVOLUTION_GROUP, () => shellCopy(ctx.locale.getSnapshot().active).evolution, 0)
  registerNested(ctx, EVOLUTION_LINES, () => shellCopy(ctx.locale.getSnapshot().active).capability, EVOLUTION_GROUP, () => shellCopy(ctx.locale.getSnapshot().active).evolution, 1)
  registerNested(ctx, EVOLUTION_SETTINGS, () => shellCopy(ctx.locale.getSnapshot().active).settings, EVOLUTION_GROUP, () => shellCopy(ctx.locale.getSnapshot().active).evolution, 2)
}

function registerNested(ctx: ShellCtx, key: string, label: () => string, group: string, groupLabel: () => string, order: number): void {
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key,
    label: pageLabel(label, { group, groupLabel }),
    order,
  }, EmptyPage))
}
