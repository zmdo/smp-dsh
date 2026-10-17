import { useLayoutEffect, useRef, type ReactNode } from 'react'

interface RenderSlot {
  (name: string, props: object, options?: { entryKey?: string; fallback?: ReactNode }): ReactNode
}

export const HARNESS_STYLE = `
.smp-console .content:has(.smp-harness-settings) {
  display: flex; flex-direction: column; overflow: hidden;
}
.smp-harness-settings { flex: 1; min-height: 0; }
.smp-harness-settings [data-slot="sidebar.settings"] { display: none !important; }
body:has(.smp-harness-settings) > div:has(> [data-shortcut-modal="settings"]) {
  position: fixed; inset: auto; margin: 0;
  top: var(--smp-harness-top, 0px); left: var(--smp-harness-left, 0px);
  width: var(--smp-harness-width, 100%); height: var(--smp-harness-height, 100%);
  z-index: 30;
}
body:has(.smp-harness-settings) > div:has(> [data-shortcut-modal="settings"]) > div:not([data-shortcut-modal="settings"]) {
  display: none;
}
body:has(.smp-harness-settings) > div:has(> [data-shortcut-modal="settings"]) [data-shortcut-modal="settings"] {
  width: 100%; height: 100%; max-width: none; border-radius: 4px; box-shadow: none;
}
body:has(.smp-harness-settings) [data-shortcut-modal="settings"] > div:last-child > div:first-child > button {
  display: none;
}
`

const PLACED = ['top', 'left', 'width', 'height'] as const

function place(node: HTMLElement): void {
  const rect = node.getBoundingClientRect()
  const root = document.documentElement
  const next = {
    top: `${Math.round(rect.top)}px`,
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(rect.width)}px`,
    height: `${Math.round(rect.height)}px`,
  }
  for (const edge of PLACED) {
    const name = `--smp-harness-${edge}`
    if (root.style.getPropertyValue(name) !== next[edge]) root.style.setProperty(name, next[edge])
  }
}

function clearPlace(): void {
  const root = document.documentElement
  for (const edge of PLACED) root.style.removeProperty(`--smp-harness-${edge}`)
}

/** The account launcher replaces the settings button, and its menu item opens the dialog. */
function openHarnessDialog(node: HTMLElement): void {
  if (document.querySelector('[data-shortcut-modal="settings"]') !== null) return
  const menu = document.querySelector('[role="menu"]')
  if (menu !== null) {
    const item = [...menu.querySelectorAll('button[role="menuitem"]')].find((button) => {
      const text = button.textContent ?? ''
      return text.includes('设置') || text.includes('Settings')
    })
    if (item instanceof HTMLElement) item.click()
    return
  }
  const launcher = node.querySelector('button[aria-haspopup="menu"]')
  if (launcher instanceof HTMLButtonElement && launcher.getAttribute('aria-expanded') !== 'true') launcher.click()
}

/**
 * The harness settings dialog is a body portal owned by `sidebar.settings`.
 * This page mounts that slot and keeps the dialog open over the content area.
 */
export function HarnessSettings(props: { renderSlot?: RenderSlot }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = host.current
    if (node === null) return
    const ensure = (): void => {
      place(node)
      try {
        openHarnessDialog(node)
      } catch (error) {
        // A missing launcher leaves the page mounted; the dialog is not required to render the shell.
        void error
      }
    }
    ensure()
    const changes = new MutationObserver(ensure)
    changes.observe(document.body, { childList: true })
    const resize = new ResizeObserver(ensure)
    resize.observe(node)
    window.addEventListener('resize', ensure)
    return () => {
      changes.disconnect()
      resize.disconnect()
      window.removeEventListener('resize', ensure)
      clearPlace()
    }
  }, [])
  return (
    <div className="smp-harness-settings" ref={host}>
      {props.renderSlot?.('sidebar.settings', { wide: true })}
    </div>
  )
}
