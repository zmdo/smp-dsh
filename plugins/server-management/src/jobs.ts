export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface JobRow {
  id: string
  serverId: string
  action: string
  status: JobStatus
  createdAt: string
}

export const RESTART_MESSAGE = '进程已重启，任务已失败，请重新执行。'
export const UNIMPLEMENTED_MESSAGE = '该任务类型还没有实现'

const KNOWN = new Set(['test_connection', 'install_components', 'inspect'])

export function isKnownAction(action: string): boolean {
  return KNOWN.has(action)
}

/** Same server and action already waiting or running. */
export function openJob(rows: readonly JobRow[], serverId: string, action: string): JobRow | undefined {
  return rows.find(row => row.serverId === serverId && row.action === action && (row.status === 'queued' || row.status === 'running'))
}

/** Oldest queued job whose server has nothing running. */
export function claimCandidate(rows: readonly JobRow[]): JobRow | undefined {
  const busy = new Set(rows.filter(row => row.status === 'running').map(row => row.serverId))
  return rows
    .filter(row => row.status === 'queued' && !busy.has(row.serverId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]
}

/** A key still attached to a server cannot be removed. */
export function keyInUse(serverCount: number): boolean {
  return serverCount > 0
}

/** A saved server is retested only when automatic install is on and the connection or selection changed. */
export function shouldRetest(input: { autoInstall: boolean; connectionChanged: boolean; selectionChanged: boolean }): boolean {
  return input.autoInstall && (input.connectionChanged || input.selectionChanged)
}

export interface RetestSnap {
  autoInstall: boolean
  host: string
  port: number
  user: string
  method: string
  keyId: string | null
  selection: string
  secretWritten: boolean
}

/** Field presence is not a change. A repeated edit of the same login must not queue another test. */
export function retestAfterEdit(before: RetestSnap, after: RetestSnap): boolean {
  const connectionChanged = before.host !== after.host
    || before.port !== after.port
    || before.user !== after.user
    || before.method !== after.method
    || before.keyId !== after.keyId
    || after.secretWritten
  const selectionChanged = before.autoInstall !== after.autoInstall || before.selection !== after.selection
  return shouldRetest({ autoInstall: after.autoInstall, connectionChanged, selectionChanged })
}

/** A restart cannot resume an SSH session that died with the process. */
export function failRunning(rows: readonly JobRow[]): JobRow[] {
  return rows.map(row => row.status === 'running' ? { ...row, status: 'failed' } : row)
}
