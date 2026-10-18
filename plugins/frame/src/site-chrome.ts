import { DEFAULT_TITLE } from './site.ts'
import { DEFAULT_ICON_DARK, DEFAULT_ICON_LIGHT } from './site-mark.ts'

export interface SiteSnap {
  title: string
  icon: string
}

export interface SiteStore {
  get(): SiteSnap
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  apply(title: string, icon: string): void
}

/** Browser tab title and favicon. An empty icon uses the control hub. */
export function applySiteChrome(title: string, icon: string): void {
  document.title = title.trim() === '' ? DEFAULT_TITLE : title
  const links = [...document.head.querySelectorAll('link[rel="icon"]')]
  if (icon === '') {
    const hrefs = links.map(link => link.getAttribute('href') ?? '')
    if (hrefs.length === 2 && hrefs[0] === DEFAULT_ICON_LIGHT && hrefs[1] === DEFAULT_ICON_DARK) return
    for (const link of links) link.remove()
    document.head.append(defaultIcon('light', DEFAULT_ICON_LIGHT), defaultIcon('dark', DEFAULT_ICON_DARK))
    return
  }
  for (const link of links) link.remove()
  const custom = document.createElement('link')
  custom.rel = 'icon'
  custom.href = icon
  document.head.append(custom)
}

function defaultIcon(scheme: 'light' | 'dark', href: string): HTMLLinkElement {
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = href
  link.media = `(prefers-color-scheme: ${scheme})`
  return link
}

function siteSnap(body: { title?: unknown; icon?: unknown }): SiteSnap {
  return {
    title: typeof body.title === 'string' && body.title !== '' ? body.title : DEFAULT_TITLE,
    icon: typeof body.icon === 'string' ? body.icon : '',
  }
}

/** One record for the tab, the sidebar, and the login page. */
export function createSiteStore(): SiteStore {
  let snap: SiteSnap = { title: DEFAULT_TITLE, icon: '' }
  const listeners = new Set<() => void>()
  const publish = (next: SiteSnap): void => {
    snap = next
    applySiteChrome(next.title, next.icon)
    for (const listener of listeners) listener()
  }
  return {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh() {
      const response = await fetch('/console-api/site', { credentials: 'same-origin' })
      if (!response.ok) return
      publish(siteSnap(await response.json() as { title?: unknown; icon?: unknown }))
    },
    apply(title, icon) {
      publish({ title: title.trim() === '' ? DEFAULT_TITLE : title, icon })
    },
  }
}
