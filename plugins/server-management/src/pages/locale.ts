import { useSyncExternalStore } from 'react'
import type { LocaleFace } from '../i18n.ts'

export function useActiveLocale(locale: LocaleFace): string {
  return useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot().active)
}
