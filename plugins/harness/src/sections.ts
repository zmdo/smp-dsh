export interface RegisteredSection {
  options: {
    id?: string
    label?: string | (() => string)
    order?: number
  }
}

export interface SectionNavItem {
  id: string
  label: string
  order: number
}

/** Nav rows for settings sections plugins registered, in order. */
export function sectionNav(entries: readonly RegisteredSection[]): SectionNavItem[] {
  const items: SectionNavItem[] = []
  for (const entry of entries) {
    const id = entry.options.id
    const raw = entry.options.label
    if (id === undefined || raw === undefined) continue
    const label = typeof raw === 'function' ? raw() : raw
    if (label === '') continue
    items.push({ id, label, order: entry.options.order ?? 0 })
  }
  items.sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return items
}
