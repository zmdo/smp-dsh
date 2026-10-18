import type { ListSource } from './contract.ts'

export interface ViewState {
  groupBy: 'workspace' | 'workspace-tree' | 'flat'
  orderBy: 'manual' | 'updated'
  archivedFilter?: 'default' | 'show' | 'only'
  groupExpansion: Record<string, boolean>
  sessionOrderByAccount: Record<string, string[]>
}
export interface ViewSource extends ListSource<ViewState> {
  actions: { retainAccountKeys(keys: readonly string[]): void }
}
export interface SlotEntry {
  options: { id?: string; priority?: number }
  inject?: () => Record<string, unknown>
  store?: { create(): ViewSource }
}
export interface Slots {
  entries(name: string): readonly SlotEntry[]
  subscribe(name: string, listener: () => void): () => void
}
export interface ShortcutState { searchRequest: number; addRequested: boolean; directoryBusy: boolean }
export interface WorkspaceFace {
  hooks: { workspaceShortcuts: ListSource<ShortcutState>; directoryFlow: ListSource<boolean> }
  requestAddWorkspace(): void
  closeAddWorkspace(): void
  startSession(id?: string, options?: { clearPreviousDraft?: boolean }): void
}
