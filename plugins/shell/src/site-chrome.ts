import { DEFAULT_TITLE } from './site.ts'

/** Browser tab title and favicon. An empty icon restores the harness files. */
export function applySiteChrome(title: string, icon: string): void {
  document.title = title.trim() === '' ? DEFAULT_TITLE : title
  const links = [...document.head.querySelectorAll('link[rel="icon"]')]
  if (icon === '') {
    if (!links.some(link => (link.getAttribute('href') ?? '').startsWith('data:'))) return
    for (const link of links) link.remove()
    document.head.append(defaultIcon('light', '/favicon.svg'), defaultIcon('dark', '/favicon-dark.svg'))
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

/** The harness title stays when this read fails. */
export function loadSiteChrome(): void {
  void fetch('/console-api/site', { credentials: 'same-origin' })
    .then(async response => {
      if (!response.ok) return
      const body = await response.json() as { title?: unknown; icon?: unknown }
      applySiteChrome(
        typeof body.title === 'string' ? body.title : '',
        typeof body.icon === 'string' ? body.icon : '',
      )
    })
    .catch((cause: unknown) => {
      void cause
    })
}
