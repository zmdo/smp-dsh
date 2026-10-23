import * as queries from './persistence/repository.ts'
import type { Db } from '../database/connection.ts'
import { listGroups, createGroup, renameGroup, deleteGroup } from '../groups/service.ts'
import { listKeys, deleteKey } from '../keys/service.ts'
import { updateServer, deleteServer } from '../servers/service.ts'
import { getHarnessServer } from '../harness/service.ts'
import {
  createChangePlan,
  readChangePlan,
  confirmChangePlan,
  controlPlan,
} from '../changes/service.ts'
import { detectUpdates, listSuggestions } from '../upgrades/service.ts'
import { mutate } from './approval.ts'
import { serverSnapshot, groupSnapshot, keySnapshot } from './persistence/repository.ts'
import { generateStoredKey, exportKeyPage } from './keys.ts'
import { rotateKey } from './rotation.ts'
import { auditAction } from './retention.ts'
import {
  AdminError,
  fields,
  object,
  text,
  uuid,
  revision,
  instant,
  type AdminDeps,
  type AdminContext,
  type Input,
} from './model.ts'

export const ADMIN_ACTIONS = {
  platform_server_group_admin: ['list', 'create', 'rename', 'delete'],
  platform_server_key_admin: ['list', 'create', 'delete', 'rotate', 'reveal'],
  platform_server_upgrade_admin: ['check', 'plan', 'show', 'apply', 'cancel'],
  platform_audit_admin: ['query', 'export', 'retention'],
  platform_server_admin: ['update', 'rebind', 'delete'],
} as const
export type AdminTool = keyof typeof ADMIN_ACTIONS
export async function executeAdmin(
  deps: AdminDeps,
  ctx: AdminContext,
  tool: AdminTool,
  action: string,
  input: Input,
): Promise<unknown> {
  if (!ctx.agent || ctx.signal.aborted) throw new AdminError('unauthorized')
  if (!(ADMIN_ACTIONS[tool] as readonly string[]).includes(action))
    throw new AdminError('invalid_action')
  switch (tool) {
    case 'platform_server_group_admin':
      return groupAction(deps, ctx, action, input)
    case 'platform_server_key_admin':
      return keyAction(deps, ctx, action, input)
    case 'platform_server_upgrade_admin':
      return planAction(deps, ctx, action, input)
    case 'platform_server_admin':
      return serverAction(deps, ctx, action, input)
    case 'platform_audit_admin':
      return auditAction(deps, ctx, action, input)
  }
}
async function groupAction(deps: AdminDeps, ctx: AdminContext, action: string, input: Input) {
  fields(
    input,
    action === 'list'
      ? []
      : action === 'create'
        ? ['name']
        : action === 'rename'
          ? ['group_id', 'name']
          : ['group_id'],
  )
  if (action === 'list') return listGroups(deps.db, deps.definitions)
  const id = action === 'create' ? 'new' : uuid(input.group_id)
  const name = action === 'create' || action === 'rename' ? text(input.name, 80) : undefined
  const read =
    action === 'create' ? async () => null : (db: Db, lock: boolean) => groupSnapshot(db, id, lock)
  return mutate(
    deps,
    ctx,
    'platform_server_group_admin',
    action,
    id,
    read,
    async (db) => {
      if (action === 'create') return createGroup(db, deps.definitions, { name })
      if (action === 'rename') return renameGroup(db, deps.definitions, id, { name })
      await deleteGroup(db, id)
      return { deleted: id }
    },
    input,
  )
}
async function keyAction(deps: AdminDeps, ctx: AdminContext, action: string, input: Input) {
  if (action === 'rotate') return rotateKey(deps, ctx, input)
  fields(input, action === 'list' ? [] : action === 'create' ? ['name'] : ['key_id'])
  if (action === 'list') return listKeys(deps.db)
  const id = action === 'create' ? 'new' : uuid(input.key_id)
  if (action === 'reveal') return exportKeyPage(deps, id)
  const name = action === 'create' ? text(input.name, 80) : undefined
  return mutate(
    deps,
    ctx,
    'platform_server_key_admin',
    action,
    id,
    action === 'create' ? async () => null : (db, lock) => keySnapshot(db, id, lock),
    async (db) => {
      if (action === 'create') return generateStoredKey({ ...deps, db }, name!)
      await deleteKey(db, id)
      return { deleted: id }
    },
    input,
  )
}
async function managedId(deps: AdminDeps, input: Input) {
  return (await getHarnessServer(deps, text(input.server))).id
}
async function serverAction(deps: AdminDeps, ctx: AdminContext, action: string, input: Input) {
  fields(
    input,
    action === 'update'
      ? ['server', 'expected_config_revision', 'patch']
      : action === 'rebind'
        ? [
            'server',
            'expected_config_revision',
            'target_group',
            'target_type',
            'install_missing',
            'software_policies',
          ]
        : ['server', 'expected_config_revision'],
  )
  const id = await managedId(deps, input),
    expected = revision(input.expected_config_revision)
  const patch = action === 'update' ? object(input.patch) : {}
  if (action === 'update') {
    fields(patch, [
      'name',
      'region',
      'declared_os',
      'install_required_software',
      'host',
      'ssh_port',
      'ssh_user',
      'ssh_key_id',
    ])
    if (!Object.keys(patch).length) throw new AdminError('invalid_request')
    for (const name of ['name', 'region', 'host', 'ssh_user'])
      if (patch[name] !== undefined) text(patch[name], name === 'host' ? 255 : 80)
    if (patch.ssh_key_id !== undefined) uuid(patch.ssh_key_id)
    if (
      patch.ssh_port !== undefined &&
      (!Number.isInteger(patch.ssh_port) ||
        Number(patch.ssh_port) < 1 ||
        Number(patch.ssh_port) > 65535)
    )
      throw new AdminError('invalid_request')
    if (
      patch.install_required_software !== undefined &&
      typeof patch.install_required_software !== 'boolean'
    )
      throw new AdminError('invalid_request')
  }
  if (action === 'rebind') {
    if (input.target_group !== null) uuid(input.target_group)
    if (typeof input.install_missing !== 'boolean' || !Array.isArray(input.software_policies))
      throw new AdminError('invalid_request')
  }
  return mutate(
    deps,
    ctx,
    'platform_server_admin',
    action,
    id,
    async (db, lock) => {
      const row = await serverSnapshot(db, id, lock)
      if (row.config_revision !== expected) throw new AdminError('server_revision_conflict')
      return patch.ssh_key_id === undefined
        ? row
        : { ...row, requested_key: await keySnapshot(db, uuid(patch.ssh_key_id), lock) }
    },
    async (db) => {
      if (action === 'delete') {
        await deleteServer(db, id)
        return { deleted: id }
      }
      if (action === 'rebind') {
        const row = await serverSnapshot(db, id)
        const planId = await createChangePlan(db, deps.definitions, {
          kind: 'move',
          server_ids: [id],
          group_id: input.target_group,
          type_key: input.target_type ?? row.type_key,
          install_missing: input.install_missing,
          software_policies: input.software_policies,
        })
        return { plan_id: planId, kind: 'move', state: 'draft', requires_approval: true }
      }
      const before = await serverSnapshot(db, id)
      const connectionChanged = ['host', 'ssh_port', 'ssh_user', 'ssh_key_id'].some(
        (key) => patch[key] !== undefined && patch[key] !== before[key],
      )
      await updateServer({ ...deps, db }, id, {
        ...patch,
        ...(patch.ssh_key_id === undefined ? {} : { auth_method: 'private_key' }),
        ...(connectionChanged ? { inspect_after_save: true } : {}),
      })
      const row = await serverSnapshot(db, id)
      return {
        server: row,
        configuration_saved: true,
        connection_test: (await queries.latestConnectionJob(db, [id])).rows[0] ?? null,
      }
    },
    input,
  )
}
async function planAction(deps: AdminDeps, ctx: AdminContext, action: string, input: Input) {
  fields(
    input,
    action === 'check'
      ? ['server']
      : action === 'plan'
        ? ['server', 'versions', 'expected_config_revision']
        : action === 'apply'
          ? ['plan_id', 'revision', 'review_digest', 'start', 'end', 'timezone']
          : ['plan_id'],
  )
  if (action === 'check') {
    const id = await managedId(deps, input)
    await detectUpdates(deps, { server_ids: [id] })
    return {
      queued: true,
      ...(await listSuggestions(deps, {
        page: 1,
        query: '',
        decision: '',
        server: id,
        group: null,
        type: null,
        software: null,
        connection: null,
        current: null,
        target: null,
      })),
    }
  }
  if (action === 'plan') {
    const id = await managedId(deps, input),
      expected = revision(input.expected_config_revision)
    object(input.versions)
    return mutate(
      deps,
      ctx,
      'platform_server_upgrade_admin',
      action,
      id,
      async (db, lock) => {
        const row = await serverSnapshot(db, id, lock)
        if (row.config_revision !== expected) throw new AdminError('server_revision_conflict')
        return row
      },
      async (db) => ({
        plan_id: await createChangePlan(db, deps.definitions, {
          kind: 'upgrade',
          server_ids: [id],
          versions: input.versions,
        }),
        state: 'draft',
        requires_approval: true,
      }),
      input,
    )
  }
  const id = uuid(input.plan_id)
  const read = async (db: Db, lock: boolean) => {
    if (lock) await queries.lockChangePlan(db, [id])
    const plan = await readChangePlan(db, id)
    if (plan.targets.length !== 1) throw new AdminError('single_server_required')
    return plan
  }
  if (action === 'show') return read(deps.db, false)
  if (action === 'apply') {
    text(input.review_digest, 64)
    text(input.revision)
    instant(input.start)
    instant(input.end)
    text(input.timezone)
  }
  return mutate(
    deps,
    ctx,
    'platform_server_upgrade_admin',
    action,
    id,
    read,
    async (db) => {
      if (action === 'cancel') await controlPlan(db, id, 'cancel')
      else
        await confirmChangePlan(db, id, {
          ...input,
          concurrency: 1,
          ack_replacement: true,
          ack_major: true,
          ack_service_impact: true,
        })
      return readChangePlan(db, id)
    },
    input,
  )
}
