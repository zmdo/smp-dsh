import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { sectionNav, type RegisteredSection } from '../sections.ts'

interface SectionSlots {
  entries(key: string): readonly RegisteredSection[]
  subscribe(key: string, listener: () => void): () => void
}

interface RenderSlot {
  (name: string, props: object, options?: { only?: string }): ReactNode
}

const STYLE = `
.smp-console .content:has(.smp-harness) { display: flex; flex-direction: column; }
.smp-harness {
  flex: 1; min-height: 0; display: flex; background: #fff;
  border: 1px solid var(--line); border-radius: 4px; overflow: hidden;
}
.smp-harness-nav {
  width: 188px; flex: none; display: flex; flex-direction: column; gap: 4px;
  padding: 16px 10px; border-right: 1px solid var(--line); overflow: auto;
}
.smp-harness-item {
  height: 36px; padding: 0 12px; border: 0; border-radius: 4px; background: transparent;
  text-align: left; color: #3c4048; cursor: pointer;
}
.smp-harness-item:hover { background: #f5f7fa; }
.smp-harness-item.is-on { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.smp-console .smp-harness {
  font-size: 14px; line-height: 22px;
}
.smp-harness-body { flex: 1; min-width: 0; overflow: auto; padding: 20px 28px 32px; }
/* General settings has no width of its own, so it stretches across the page.
   The other sections already stop around 720–760. */
.smp-console .smp-harness-body [data-slot="settings.section"] > * { max-width: 760px; }
.smp-harness-empty { margin: 0; color: var(--muted); }
`

function closeSettings(): void {}

function useSections(slots: SectionSlots): ReturnType<typeof sectionNav> {
  const entries = useSyncExternalStore(
    listener => slots.subscribe('settings.section', listener),
    () => slots.entries('settings.section'),
  )
  return sectionNav(entries)
}

export function HarnessSettings(props: { slots: SectionSlots; renderSlot?: RenderSlot }) {
  const sections = useSections(props.slots)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const active = sections.some(section => section.id === picked) ? picked : sections[0]?.id
  return (
    <div className="smp-harness">
      <nav className="smp-harness-nav" aria-label="Harness 设置">
        {sections.map(section => (
          <button
            key={section.id}
            className={`smp-harness-item${section.id === active ? ' is-on' : ''}`}
            type="button"
            aria-current={section.id === active ? 'true' : undefined}
            onClick={() => setPicked(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <div className="smp-harness-body">
        {active === undefined
          ? <p className="smp-harness-empty">没有已登记的设置</p>
          : props.renderSlot?.('settings.section', { close: closeSettings }, { only: active })}
      </div>
    </div>
  )
}

export function installStyle(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@smp/console-harness'
  tag.textContent = STYLE
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
