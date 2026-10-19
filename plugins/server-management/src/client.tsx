import { pageLabel } from './page-label.ts'
import { serverCopy, type LocaleFace } from './i18n.ts'
import { KeysPage } from './pages/KeysPage.tsx'
import { installServersStyle, ServersPage } from './pages/ServersPage.tsx'
import { createServerPageState } from './pages/server-page-state.ts'

interface PageSlots {
  inject(name: string, register: () => () => void): void
  register(options: object, component: unknown): () => void
}

interface ClientCtx {
  slots: PageSlots
  locale: LocaleFace
  effect(run: () => (() => void)): void
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientCtx): void {
  const pageState = createServerPageState()
  ctx.effect(() => () => pageState.dispose())
  const copy = () => serverCopy(ctx.locale.getSnapshot().active).ui
  const group = { group: 'server-management', groupLabel: () => copy().groupTitle }
  ctx.effect(installServersStyle)
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: 'servers',
    label: pageLabel(() => copy().serversTab, { ...group, icon: 'server' }),
    order: 0,
    inject: () => ({ locale: ctx.locale, pageState }),
  }, ServersPage))
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: 'ssh-keys',
    label: pageLabel(() => copy().keysTab, group),
    order: 1,
    inject: () => ({ locale: ctx.locale }),
  }, KeysPage))
}
