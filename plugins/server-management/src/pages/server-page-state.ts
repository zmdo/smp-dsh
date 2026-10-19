export interface ServerListView {
  groupId: string | null
  query: string
  page: number
  pageSize: number
  status: string
  order: 'name' | 'last_checked'
}
export interface ServerPageSnapshot {
  screen: 'list' | 'form' | 'detail' | 'terminal'
  serverId: string
  editing: boolean
  listView: ServerListView
}

/** Owned by one client plugin instance, so settings navigation does not erase the server page. */
export function createServerPageState() {
  let snapshot: ServerPageSnapshot = { screen: 'list', serverId: '', editing: false,
    listView: { groupId: null, query: '', page: 1, pageSize: 10, status: '', order: 'name' } }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(values: Partial<ServerPageSnapshot>) {
      snapshot = { ...snapshot, ...values }
      for (const listener of listeners) listener()
    },
    dispose() { listeners.clear() },
  }
}
export type ServerPageState = ReturnType<typeof createServerPageState>
