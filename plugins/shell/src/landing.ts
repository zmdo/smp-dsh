import type { NavGroup } from './pages.ts'

/** Harness conversation. Opening it leaves the console panel. */
export const DEFAULT_LANDING = 'agent-chat'

const PAGE_KEY = /^[A-Za-z0-9_-]{1,64}$/

export interface LandingPage {
  key: string
  label: string
  group: string
  groupLabel: string
}

export type LandingDraft =
  | { ok: true; page: string }
  | { ok: false }

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** Every registered page, nav groups first. A group with children contributes each child. */
export function landingPages(groups: { nav: readonly NavGroup[]; footer: readonly NavGroup[] }): LandingPage[] {
  const pages: LandingPage[] = []
  for (const group of [...groups.nav, ...groups.footer]) {
    for (const page of group.pages) {
      pages.push({ key: page.key, label: page.label, group: group.id, groupLabel: group.label })
    }
  }
  return pages
}

/** Groups with more than one page, or a page title that differs from the group, name both. */
export function landingLabel(page: LandingPage, pages: readonly LandingPage[]): string {
  const siblings = pages.filter(item => item.group === page.group).length
  if (siblings > 1 || page.groupLabel !== page.label) return `${page.groupLabel} / ${page.label}`
  return page.label
}

/** Keep a stored page that is still registered. Otherwise the Harness conversation. */
export function landingChoice(stored: string, pages: readonly { key: string }[]): string {
  if (pages.length === 0) return PAGE_KEY.test(stored) ? stored : DEFAULT_LANDING
  if (pages.some(page => page.key === stored)) return stored
  if (pages.some(page => page.key === DEFAULT_LANDING)) return DEFAULT_LANDING
  return pages[0]?.key ?? DEFAULT_LANDING
}

export function landingDraft(body: unknown): LandingDraft {
  if (body === null || typeof body !== 'object') return { ok: false }
  const page = (body as { page?: unknown }).page
  if (typeof page !== 'string' || !PAGE_KEY.test(page)) return { ok: false }
  return { ok: true, page }
}

export async function loadLanding(db: Queryable): Promise<string> {
  const result = await db.query('select landing_page from console_site where id = true')
  const page = result.rows[0]?.landing_page
  return typeof page === 'string' && PAGE_KEY.test(page) ? page : DEFAULT_LANDING
}

export async function saveLanding(db: Queryable, page: string): Promise<void> {
  await db.query('update console_site set landing_page = $1 where id = true', [page])
}
