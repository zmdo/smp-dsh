export type SectionId =
  | 'dashboard'
  | 'quant-overview'
  | 'quant-markets'
  | 'quant-exchanges'
  | 'quant-strategies'
  | 'wallet'
  | 'cards'
  | 'servers'
  | 'keys'
  | 'settings'
  | 'mcp'

export interface SectionStore {
  get(): SectionId
  set(next: SectionId): void
  subscribe(listener: () => void): () => void
}

/** One console's selected column. Created inside apply, so a reload does not keep the previous one. */
export function createSection(): SectionStore {
  let current: SectionId = 'dashboard'
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(next) {
      if (current === next) return
      current = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
