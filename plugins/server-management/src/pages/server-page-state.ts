export interface ServerListView {
  groupId: string | null
  query: string
  page: number
  pageSize: number
  status: string
  needsUpgrade?:boolean
  order: 'name' | 'last_checked'
}
export interface ServerPageSnapshot {
  screen: 'list' | 'form' | 'detail' | 'terminal'
  serverId: string
  editing: boolean
  listView: ServerListView
  upgradeContext?: {serverId?:string;groupId?:string}
  upgradeView: {
    tab: 'suggestions' | 'plans' | 'records'
    page: number
    planId: string
  }
}

/** Owned by one client plugin instance, so settings navigation does not erase the server page. */
export function createServerPageState() {
  let snapshot: ServerPageSnapshot = { screen: 'list', serverId: '', editing: false,
    listView: { groupId: null, query: '', page: 1, pageSize: 10, status: '', order: 'name' },
    upgradeView: { tab: 'suggestions', page: 1, planId: '' } }
  const listeners = new Set<() => void>()
  const update = (values: Partial<ServerPageSnapshot>) => {
    snapshot = { ...snapshot, ...values }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update,
    selectUpgradeTab(tab: ServerPageSnapshot['upgradeView']['tab']) {
      update({ upgradeView: { tab, page: 1, planId: '' } })
    },
    setUpgradePage(page: number) {
      update({ upgradeView: { ...snapshot.upgradeView, page } })
    },
    showUpgradePlan(planId: string) {
      update({ upgradeView: { tab: 'plans', page: 1, planId } })
    },
    dispose() { listeners.clear() },
  }
}
export type ServerPageState = ReturnType<typeof createServerPageState>
