import {
  GENERAL_GROUP_ID,
  judgingGroup,
  pagesHidden,
  sessionWorkspaceGroup,
  type AllowSpec,
  type GroupSpec,
  type MemberRow,
  type SessionFace,
  type WorkspaceFace,
} from './rules.ts'

export interface GroupSnapshot {
  groups: (GroupSpec & { path: string })[]
  members: MemberRow[]
  focus: { groupId: string; workspaceId: string }[]
  allows: AllowSpec[]
}

export const EMPTY_SNAPSHOT: GroupSnapshot = { groups: [], members: [], focus: [], allows: [] }

interface Listenable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Shared browser state: the selected group, the host snapshot, and which pages the shell hides. */
export class GroupStore {
  private snapshot: GroupSnapshot = EMPTY_SNAPSHOT
  private selected = GENERAL_GROUP_ID
  private hidden: string[] = []
  private placed = false
  private readonly listeners = new Set<() => void>()
  private readonly sessions: Listenable<SessionFace>
  private readonly workspaces: Listenable<{ items: readonly WorkspaceFace[] }>

  constructor(sessions: Listenable<SessionFace>, workspaces: Listenable<{ items: readonly WorkspaceFace[] }>) {
    this.sessions = sessions
    this.workspaces = workspaces
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): GroupSnapshot => this.snapshot
  selectedId = (): string => this.selected
  hiddenPages = (): string[] => this.hidden

  watch(): () => void {
    const stopSessions = this.sessions.subscribe(() => { this.recompute() })
    const stopWorkspaces = this.workspaces.subscribe(() => { this.recompute() })
    this.recompute()
    return () => {
      stopSessions()
      stopWorkspaces()
    }
  }

  replace(snapshot: GroupSnapshot): void {
    this.snapshot = snapshot
    if (!this.placed) {
      this.placed = true
      try {
        const workspaceSnapshot = this.workspaces.getSnapshot()
        const items = Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []
        const fromSession = sessionWorkspaceGroup(this.sessions.getSnapshot(), [...items], snapshot.members)
        if (fromSession !== undefined && snapshot.groups.some(group => group.id === fromSession)) this.selected = fromSession
      } catch {
        this.selected = GENERAL_GROUP_ID
      }
    }
    this.recompute()
  }

  select(groupId: string): void {
    if (this.selected === groupId) return
    this.selected = groupId
    this.recompute()
  }

  private recompute(): void {
    let sessionGroup: string | undefined
    try {
      const workspaceSnapshot = this.workspaces.getSnapshot()
      const items = Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []
      sessionGroup = sessionWorkspaceGroup(this.sessions.getSnapshot(), [...items], this.snapshot.members)
    } catch {
      sessionGroup = undefined
    }
    const groupId = judgingGroup(sessionGroup, this.selected)
    const next = pagesHidden(this.snapshot.allows, groupId, new Set(this.snapshot.groups.map(group => group.id)))
    const same = next.length === this.hidden.length && next.every((page, index) => page === this.hidden[index])
    if (!same) this.hidden = next
    for (const listener of this.listeners) listener()
  }
}
