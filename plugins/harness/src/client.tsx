import { HarnessSettings, installStyle } from './pages/HarnessSettings.tsx'
import { pageLabel } from './page-label.ts'

interface SectionSlots {
  entries(key: string): readonly { options: { id?: string; label?: string | (() => string); order?: number } }[]
  subscribe(key: string, listener: () => void): () => void
  inject(name: string, register: () => () => void): void
  register(options: object, component: unknown): () => void
}

interface HarnessCtx {
  slots: SectionSlots
  effect(run: () => (() => void)): void
}

const HARNESS_PAGE = 'harness'

export const inject = ['slots']

export function apply(ctx: HarnessCtx): void {
  ctx.effect(installStyle)
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: HARNESS_PAGE,
    label: pageLabel('Harness 设置', { group: 'platform', groupLabel: '平台设置', placement: 'footer' }),
    order: 10,
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
    },
    inject: () => ({ slots: ctx.slots }),
  }, HarnessSettings))
}
