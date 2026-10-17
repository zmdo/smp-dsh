import { DEFAULT_LANDING, landingDraft } from './landing.ts'

export interface LandingStore {
  get(): string
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  apply(page: string): void
}

/** The page opened after sign-in. Empty storage stays on the Harness conversation. */
export function createLandingStore(): LandingStore {
  let page = DEFAULT_LANDING
  const listeners = new Set<() => void>()
  const publish = (next: string): void => {
    page = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => page,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh() {
      const response = await fetch('/console-api/landing', { credentials: 'same-origin' })
      if (!response.ok) return
      const draft = landingDraft(await response.json() as unknown)
      if (!draft.ok) return
      publish(draft.page)
    },
    apply(next) {
      publish(next)
    },
  }
}
