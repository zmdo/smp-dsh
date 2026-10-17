export interface RegisteredPage {
  options: {
    key?: string
    label?: string | PageLabel
    order?: number
  }
}

/** Where a group sits. Footer groups stay at the bottom of the sidebar. */
export type PagePlacement = 'nav' | 'footer'

/**
 * Tab text plus the sidebar group. The slot ledger keeps `label` and drops
 * other register fields, so the group rides on this function.
 */
export interface PageLabel {
  (): string
  group?: string
  groupLabel?: string | (() => string)
  placement?: PagePlacement
}

export interface PageRoute {
  key: string
  label: string
  order: number
  group: string
  groupLabel: string
  placement: PagePlacement
}

export interface NavGroup {
  id: string
  label: string
  placement: PagePlacement
  order: number
  pages: PageRoute[]
}

/** Pages that share a group become one sidebar item and a row of tabs. */
export function pageLabel(text: string | (() => string), place?: { group: string; groupLabel: string | (() => string); placement?: PagePlacement }): PageLabel {
  const label: PageLabel = () => typeof text === 'function' ? text() : text
  if (place !== undefined) {
    label.group = place.group
    label.groupLabel = place.groupLabel
    if (place.placement !== undefined) label.placement = place.placement
  }
  return label
}

function placementOf(label: string | PageLabel): PagePlacement | undefined {
  if (typeof label !== 'function') return undefined
  return label.placement === 'footer' ? 'footer' : label.placement === 'nav' ? 'nav' : undefined
}

function groupText(raw: string | PageLabel, fallback: string): string {
  if (typeof raw !== 'function') return fallback
  const value = raw.groupLabel
  if (typeof value === 'function') {
    const text = value()
    return text === '' ? fallback : text
  }
  if (value !== undefined && value !== '') return value
  return fallback
}

/** Sidebar groups and their tabs, in registration order. A page without a group is its own item. */
export function pageRoutes(entries: readonly RegisteredPage[]): PageRoute[] {
  const routes: PageRoute[] = []
  for (const entry of entries) {
    const key = entry.options.key
    const raw = entry.options.label
    if (key === undefined || raw === undefined) continue
    const label = typeof raw === 'function' ? raw() : raw
    if (label === '') continue
    const group = typeof raw === 'function' && raw.group !== undefined && raw.group !== '' ? raw.group : key
    const groupLabel = groupText(raw, label)
    routes.push({
      key,
      label,
      order: entry.options.order ?? 0,
      group,
      groupLabel,
      placement: placementOf(raw) ?? 'nav',
    })
  }
  routes.sort((left, right) => left.order - right.order || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return routes
}

/** Split routes into the scrolling nav and the footer. One footer page keeps the whole group at the bottom. */
export function navGroups(routes: readonly PageRoute[]): { nav: NavGroup[]; footer: NavGroup[] } {
  const byId = new Map<string, NavGroup>()
  for (const route of routes) {
    const existing = byId.get(route.group)
    if (existing === undefined) {
      byId.set(route.group, {
        id: route.group,
        label: route.groupLabel,
        placement: route.placement,
        order: route.order,
        pages: [route],
      })
      continue
    }
    existing.pages.push(route)
    if (route.order < existing.order) {
      existing.order = route.order
      existing.label = route.groupLabel
    }
    if (route.placement === 'footer') existing.placement = 'footer'
  }
  const nav: NavGroup[] = []
  const footer: NavGroup[] = []
  for (const group of byId.values()) {
    group.pages.sort((left, right) => left.order - right.order || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    if (group.placement === 'footer') footer.push(group)
    else nav.push(group)
  }
  const byOrder = (left: NavGroup, right: NavGroup): number => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  nav.sort(byOrder)
  footer.sort(byOrder)
  return { nav, footer }
}
