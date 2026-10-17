import { modelsTabLabel } from './label.ts'
import { pageLabel } from './page-label.ts'

interface LocaleFace {
  getSnapshot(): { active: string }
}

interface PageSlots {
  inject(name: string, register: () => () => void): void
  register(options: object, component: unknown): () => void
}

interface ModelsClient {
  slots: PageSlots
  locale: LocaleFace
}

const MODELS_PAGE = 'models'

export const inject = ['slots', 'locale']

export function apply(ctx: ModelsClient): void {
  ctx.slots.inject('console.page', () => ctx.slots.register({
    name: 'console.page',
    key: MODELS_PAGE,
    label: pageLabel(
      () => modelsTabLabel(ctx.locale.getSnapshot().active),
      { group: 'platform', groupLabel: '平台设置', placement: 'footer' },
    ),
    order: 8,
  }, () => null))
}
