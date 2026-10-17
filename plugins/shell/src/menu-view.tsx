import { useState, useSyncExternalStore, type DragEvent, type FormEvent } from 'react'
import { Panel } from '@smp/console-kit'
import { shellCopy } from './copy.ts'
import type { MenuStore } from './menu-store.ts'
import { landingChoice, landingLabel, landingPages } from './landing.ts'
import type { LandingStore } from './landing-store.ts'
import { createGroup, deleteGroup, menuChoices, menuList, moveItem, resolveLayout, type MenuLayout, type MenuOption } from './menu.ts'
import { navGroups, pageRoutes, visibleGroups, type RegisteredPage } from './pages.ts'
import type { LocaleFace } from './general-view.tsx'

interface PageSlots {
  entries(name: string): readonly RegisteredPage[]
  subscribe(name: string, listener: () => void): () => void
}

export function MenuView(props: { slots: PageSlots; locale: LocaleFace; menu: MenuStore; landing: LandingStore }) {
  const entries = useSyncExternalStore(listener => props.slots.subscribe('console.page', listener), () => props.slots.entries('console.page'))
  const locale = useSyncExternalStore(listener => props.locale.subscribe(listener), () => props.locale.getSnapshot())
  const saved = useSyncExternalStore(props.menu.subscribe, props.menu.get)
  const landingPage = useSyncExternalStore(props.landing.subscribe, props.landing.get)
  const copy = shellCopy(locale.active)
  const routes = navGroups(pageRoutes(entries))
  const destinations = landingPages(routes)
  const landingValue = landingChoice(landingPage, destinations)
  const options = menuChoices(visibleGroups(routes), copy.harness)
  const layout = resolveLayout(saved, copy.overview)
  const list = menuList(options, layout, copy.overview)
  const [name, setName] = useState('')
  const [over, setOver] = useState('')
  const [error, setError] = useState('')
  const [landingNote, setLandingNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function persist(next: MenuLayout): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/console-api/menu', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      const payload = await response.json() as { detail?: unknown }
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : copy.requestFailed)
      props.menu.apply(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function onLanding(page: string): Promise<void> {
    if (page === landingValue) return
    setBusy(true)
    setError('')
    setLandingNote('')
    try {
      const response = await fetch('/console-api/landing', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page }),
      })
      const payload = await response.json() as { detail?: unknown }
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : copy.requestFailed)
      props.landing.apply(page)
      setLandingNote(copy.landingSaved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  function onCreate(event: FormEvent): void {
    event.preventDefault()
    if (name.trim() === '') return
    const next = createGroup(layout, name, groupId())
    if (!('groups' in next)) {
      setError(copy.menuDuplicate)
      return
    }
    setName('')
    void persist(next)
  }

  function onDelete(id: string): void {
    void persist(deleteGroup(layout, id))
  }

  function onDrop(event: DragEvent<HTMLElement>, groupId: string): void {
    event.preventDefault()
    setOver('')
    const optionId = event.dataTransfer.getData('text/plain') || dragging
    dragging = ''
    if (optionId === '') return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-option]')]
    let index = rows.length
    for (let i = 0; i < rows.length; i += 1) {
      const box = rows[i]?.getBoundingClientRect()
      if (box !== undefined && event.clientY < box.top + box.height / 2) {
        index = i
        break
      }
    }
    void persist(moveItem(layout, options, optionId, groupId, index))
  }

  return (
    <Panel title={copy.menu}>
      <label className="menu-landing">{copy.landing}
        <select aria-label={copy.landing} value={landingValue} disabled={busy} onChange={event => { void onLanding(event.target.value) }}>
          {destinations.map(page => (
            <option key={page.key} value={page.key}>{landingLabel(page, destinations)}</option>
          ))}
        </select>
      </label>
      {landingNote !== '' && <p className="banner ok">{landingNote}</p>}
      <p className="muted">{copy.menuHint}</p>
      <form className="menu-create" onSubmit={onCreate}>
        <input value={name} maxLength={40} placeholder={copy.menuName} onChange={event => setName(event.target.value)} />
        <button className="secondary" type="submit" disabled={busy}>{copy.menuCreate}</button>
      </form>
      {error !== '' && <p className="banner">{error}</p>}
      <div className="menu-board">
        <DropList title={copy.menuUngrouped} groupId="" items={list.ungrouped} over={over} setOver={setOver} onDrop={onDrop} empty={copy.menuEmpty} />
        {list.groups.map(group => (
          <DropList
            key={group.id}
            title={group.title}
            groupId={group.id}
            items={group.items}
            over={over}
            setOver={setOver}
            onDrop={onDrop}
            empty={copy.menuEmpty}
            onDelete={() => onDelete(group.id)}
            deleteLabel={copy.menuDelete}
          />
        ))}
      </div>
    </Panel>
  )
}

function DropList(props: {
  title: string
  groupId: string
  items: readonly MenuOption[]
  over: string
  setOver: (id: string) => void
  onDrop: (event: DragEvent<HTMLElement>, groupId: string) => void
  empty: string
  onDelete?: () => void
  deleteLabel?: string
}) {
  return (
    <section
      aria-label={props.title}
      className={`menu-group${props.over === props.groupId ? ' is-over' : ''}`}
      onDragOver={event => {
        event.preventDefault()
        props.setOver(props.groupId)
      }}
      onDragLeave={() => { if (props.over === props.groupId) props.setOver('') }}
      onDrop={event => props.onDrop(event, props.groupId)}
    >
      <header>
        <span>{props.title}</span>
        {props.onDelete !== undefined && (
          <button className="link" type="button" onClick={props.onDelete}>{props.deleteLabel}</button>
        )}
      </header>
      {props.items.map(item => (
        <div
          key={item.id}
          role="button"
          aria-label={item.label}
          className="menu-item"
          data-option={item.id}
          draggable
          onDragStart={event => {
            dragging = item.id
            event.dataTransfer.setData('text/plain', item.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
        >
          <span className="menu-grip" aria-hidden="true" />
          <span>{item.label}</span>
        </div>
      ))}
      {props.items.length === 0 && <p className="menu-empty">{props.empty}</p>}
    </section>
  )
}

let dragging = ''

function groupId(): string {
  return `g${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
