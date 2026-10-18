import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  DEFAULT_WORKSPACE_TITLE,
  GENERAL_GROUP_ID,
  GENERAL_GROUP_LABEL,
  claimWorkspace,
  focusedWorkspace,
  normalizeAllow,
  normalizeGroup,
  pagesHidden,
  planDefault,
  pluginUsable,
  rememberAllow,
  rememberGroup,
  toolRefusal,
  ungroupedIds,
  type AllowSpec,
  type GroupSpec,
  type MemberRow,
} from './rules.ts'
import { defaultWorkspacePath, ensureDirectory, resolveGroupDirectory } from './paths.ts'

interface QueryResult<T> {
  rows: T[]
}

interface Queryable {
  query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>
}

interface WorkspaceRecord {
  id: string
  path: string
  title: string
}

interface WorkspaceRegistry {
  list(): readonly WorkspaceRecord[]
  create(path: string, title?: string): Promise<WorkspaceRecord>
}

interface RegisteredGroup extends GroupSpec {
  path: string
}

interface MemberRecord extends Record<string, unknown> {
  workspace_id: string
  group_id: string
  is_default: boolean
}

interface FocusRecord extends Record<string, unknown> {
  group_id: string
  workspace_id: string
}

export interface WorkspaceGroupView {
  groups: RegisteredGroup[]
  members: MemberRow[]
  focus: { groupId: string; workspaceId: string }[]
  allows: AllowSpec[]
}

/** Host-side registry of workspace groups. Browser code uses the client service of the same name. */
export class WorkspaceGroups extends Service {
  private readonly db: Queryable
  private readonly registry: WorkspaceRegistry
  private groups: GroupSpec[] = []
  private bound = new Map<string, string>()
  private allows: AllowSpec[] = []

  constructor(ctx: Context, db: Queryable, registry: WorkspaceRegistry) {
    super(ctx, 'workspaceGroups')
    this.db = db
    this.registry = registry
  }

  async register(input: { id: string; label: string; directory: string; order?: number }): Promise<void> {
    const spec = normalizeGroup(input)
    const path = resolveGroupDirectory(homedir(), spec.directory)
    await ensureDirectory(path)
    this.groups = rememberGroup(this.groups, spec)
    this.bound.set(spec.id, path)
    await this.ensureDefault(spec.id)
  }

  allow(input: { id: string; groups: readonly string[]; pages?: readonly string[] }): void {
    this.allows = rememberAllow(this.allows, normalizeAllow(input))
  }

  /** True when the plugin did not call allow, or named this registered group. */
  usable(pluginId: string, groupId: string): boolean {
    return pluginUsable(this.allows, pluginId, groupId, new Set(this.groups.map(group => group.id)))
  }

  /** The sentence a tool returns when the session's workspace group is outside its allow list. */
  refusal(pluginId: string, groupId: string): string | undefined {
    if (this.usable(pluginId, groupId)) return undefined
    const label = this.groups.find(group => group.id === groupId)?.label ?? groupId
    return toolRefusal(label)
  }

  async adoptUngrouped(groupId: string): Promise<void> {
    const members = await this.members()
    for (const workspaceId of ungroupedIds(this.registry.list().map(workspace => workspace.id), members)) {
      await this.db.query(
        `insert into workspace_group_members (workspace_id, group_id, is_default) values ($1, $2, false)
         on conflict (workspace_id) do nothing`,
        [workspaceId, groupId],
      )
    }
  }

  async claim(workspaceId: string, groupId: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (!this.groups.some(group => group.id === groupId)) return { ok: false, detail: '没有这个工作区组' }
    if (!this.registry.list().some(workspace => workspace.id === workspaceId)) return { ok: false, detail: '没有这个工作区' }
    const members = await this.members()
    const decision = claimWorkspace(members, workspaceId, groupId, this.labelOf(members.find(row => row.workspaceId === workspaceId)?.groupId))
    if (!decision.ok) return decision
    if (decision.insert) {
      await this.db.query(
        `insert into workspace_group_members (workspace_id, group_id, is_default) values ($1, $2, false)
         on conflict (workspace_id) do nothing`,
        [workspaceId, groupId],
      )
    }
    return { ok: true }
  }

  async focus(groupId: string, workspaceId: string): Promise<void> {
    const members = await this.members()
    if (!members.some(row => row.groupId === groupId && row.workspaceId === workspaceId)) return
    await this.db.query(
      `insert into workspace_group_focus (group_id, workspace_id) values ($1, $2)
       on conflict (group_id) do update set workspace_id = excluded.workspace_id`,
      [groupId, workspaceId],
    )
  }

  async entry(groupId: string): Promise<string | undefined> {
    const members = await this.members()
    const focus = await this.focusRows()
    return focusedWorkspace(members, groupId, focus.find(row => row.groupId === groupId)?.workspaceId)
  }

  async view(): Promise<WorkspaceGroupView> {
    const [members, focus] = await Promise.all([this.members(), this.focusRows()])
    const groups = [...this.groups]
      .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(group => ({ ...group, path: this.bound.get(group.id) ?? '' }))
    return { groups, members, focus, allows: this.allows }
  }

  hiddenPages(groupId: string): string[] {
    return pagesHidden(this.allows, groupId, new Set(this.groups.map(group => group.id)))
  }

  private labelOf(groupId: string | undefined): string {
    if (groupId === undefined) return GENERAL_GROUP_LABEL
    return this.groups.find(group => group.id === groupId)?.label ?? groupId
  }

  private async members(): Promise<MemberRow[]> {
    const result = await this.db.query<MemberRecord>('select workspace_id, group_id, is_default from workspace_group_members')
    return result.rows.map(row => ({ workspaceId: row.workspace_id, groupId: row.group_id, isDefault: row.is_default }))
  }

  private async focusRows(): Promise<{ groupId: string; workspaceId: string }[]> {
    const result = await this.db.query<FocusRecord>('select group_id, workspace_id from workspace_group_focus')
    return result.rows.map(row => ({ groupId: row.group_id, workspaceId: row.workspace_id }))
  }

  private async ensureDefault(groupId: string): Promise<void> {
    const bound = this.bound.get(groupId)
    if (bound === undefined) return
    const path = defaultWorkspacePath(bound)
    await ensureDirectory(path)
    const members = await this.members()
    const existing = this.registry.list().find(workspace => workspace.path === path)
    const plan = planDefault(members, groupId, existing?.id)
    if (plan.action === 'keep') return
    const workspaceId = plan.action === 'mark'
      ? plan.workspaceId
      : (await this.registry.create(path, DEFAULT_WORKSPACE_TITLE)).id
    await this.db.query('update workspace_group_members set is_default = false where group_id = $1 and is_default = true', [groupId])
    await this.db.query(
      `insert into workspace_group_members (workspace_id, group_id, is_default) values ($1, $2, true)
       on conflict (workspace_id) do update set group_id = excluded.group_id, is_default = true`,
      [workspaceId, groupId],
    )
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceGroups: WorkspaceGroups
  }
}

interface HostCtx extends Context {
  database: { pool: Queryable }
  workspaceRegistry: WorkspaceRegistry
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }): () => void
  }
  consoleSession: { read(cookieHeader: string): Promise<unknown> }
}

export const inject = ['database', 'workspaceRegistry', 'webServer', 'consoleSession']

const GENERAL = { id: GENERAL_GROUP_ID, label: GENERAL_GROUP_LABEL, directory: '.smp/workspaces', order: 0 }

export async function* apply(ctx: HostCtx): AsyncGenerator<() => void> {
  const groups = new WorkspaceGroups(ctx, ctx.database.pool, ctx.workspaceRegistry)
  const routes = [
    ctx.webServer.register({ kind: 'exact', path: '/console-api/workspace-groups', handler: (request, response) => handle(ctx, groups, request, response) }),
    ctx.webServer.register({ kind: 'exact', path: '/console-api/workspace-groups/claim', handler: (request, response) => handle(ctx, groups, request, response) }),
    ctx.webServer.register({ kind: 'exact', path: '/console-api/workspace-groups/focus', handler: (request, response) => handle(ctx, groups, request, response) }),
  ]
  yield () => { for (const dispose of routes) dispose() }
  await groups.register(GENERAL)
  await groups.adoptUngrouped(GENERAL.id)
}

async function handle(ctx: HostCtx, groups: WorkspaceGroups, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const account = await ctx.consoleSession.read(cookieOf(request))
  if (account === undefined) {
    send(response, 401, { detail: '未登录' })
    return
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  try {
    if (request.method === 'GET' && url.pathname === '/console-api/workspace-groups') {
      send(response, 200, await groups.view())
      return
    }
    if (request.method === 'POST' && url.pathname === '/console-api/workspace-groups/claim') {
      const body = await readJson(request)
      const workspaceId = textField(body, 'workspaceId')
      const groupId = textField(body, 'groupId')
      if (workspaceId === '' || groupId === '') {
        send(response, 400, { detail: '缺少工作区或工作区组' })
        return
      }
      const result = await groups.claim(workspaceId, groupId)
      send(response, result.ok ? 200 : 409, result)
      return
    }
    if (request.method === 'POST' && url.pathname === '/console-api/workspace-groups/focus') {
      const body = await readJson(request)
      const workspaceId = textField(body, 'workspaceId')
      const groupId = textField(body, 'groupId')
      if (workspaceId === '' || groupId === '') {
        send(response, 400, { detail: '缺少工作区或工作区组' })
        return
      }
      await groups.focus(groupId, workspaceId)
      send(response, 200, { ok: true })
      return
    }
    send(response, 404, { detail: '没有这个接口' })
  } catch (error) {
    const detail = error instanceof Error && error.message !== '' ? error.message : '没有完成'
    send(response, 400, { detail })
  }
}

function cookieOf(request: IncomingMessage): string {
  const value = request.headers.cookie
  if (Array.isArray(value)) return value.join('; ')
  return value ?? ''
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text) as unknown
}

function textField(body: unknown, key: string): string {
  if (body === null || typeof body !== 'object' || !(key in body)) return ''
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}
