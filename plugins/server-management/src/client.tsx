import { pageLabel } from './page-label.ts'
import { KeysPage } from './pages/KeysPage.tsx'
import { ServersPage } from './pages/ServersPage.tsx'

interface PageSlots {
  inject(name: string, register: () => () => void): void
  register(options: object, component: unknown): () => void
}

interface ClientCtx {
  slots: PageSlots
}

export const inject = ['slots']

const GROUP = { group: 'server-management', groupLabel: '服务器管理' }

export function apply(ctx: ClientCtx): void {
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: 'servers',
    label: pageLabel(() => '服务器', { ...GROUP, icon: 'server' }),
    order: 0,
    inject: () => ({}),
  }, ServersPage))
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: 'ssh-keys',
    label: pageLabel(() => '密钥', GROUP),
    order: 1,
    inject: () => ({}),
  }, KeysPage))
}
