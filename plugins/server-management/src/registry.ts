import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { CatalogError, componentRevision, type Component } from './catalog.ts'
import { GENERAL_TYPE, VACANT_TYPE, type GroupRecord, type GroupView, type LocalizedText, type ServerTypeView, type SoftwareView, type SystemGroupDefinition, type TypeOptions } from './definitions.ts'
import { ServerError } from './i18n.ts'
import type { Db } from './store.ts'

interface Registration {
  identity: string
  id: string
  active: boolean
  types: readonly ServerTypeView[]
  defaultType: string
  catalog: readonly Component[]
  leases: Set<symbol>
  drained: Set<() => void>
  closing?: Promise<void>
}

export interface TypeLease {
  type: ServerTypeView
  components: readonly Component[]
  signature: string
  release(): void
}

const KEY = /^[a-z][a-z0-9-]{0,63}$/

export function softwareView(item: Component): SoftwareView {
  return { id: item.id, name: item.name, summary: item.summary, name_i18n: item.name_i18n, summary_i18n: item.summary_i18n, requires: [...item.requires], recipe: item.recipe, revision: componentRevision(item) }
}

/** Dependency order is computed from the selected type, not from a global install selection. */
export function requiredSoftware(catalog: readonly Component[], ids: readonly string[]): Component[] {
  const all = new Map(catalog.map(item => [item.id, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const result: Component[] = []
  const visit = (id: string) => {
    if (visited.has(id)) return
    const item = all.get(id)
    if (item === undefined) throw new CatalogError('component_unknown', { component: id })
    if (visiting.has(id)) throw new CatalogError('component_cycle', { component: id })
    visiting.add(id)
    for (const dependency of item.requires) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    result.push(item)
  }
  for (const id of ids) visit(id)
  return result
}

export function builtinTypes(catalog: readonly Component[]): readonly ServerTypeView[] {
  return [
    { key: VACANT_TYPE, name_i18n: { zh: '空置服务器', en: 'Vacant server' }, software: [] },
    { key: GENERAL_TYPE, name_i18n: { zh: '普通服务器', en: 'General-purpose server' }, software: requiredSoftware(catalog, ['docker', 'compose']).map(softwareView) },
  ]
}

/** Owned by one plugin apply. Persistent labels never authorize scripts after their provider unloads. */
export class DefinitionRegistry {
  private readonly registrations = new Map<string, Registration>()
  private readonly identities = new Set<string>()
  private readonly writes = new Set<Promise<unknown>>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly defaults: readonly ServerTypeView[]
  private readonly db: Db
  private readonly base: readonly Component[]

  constructor(db: Db, base: readonly Component[]) {
    this.db = db
    this.base = base
    this.defaults = builtinTypes(base)
  }

  async registerGroup(input: SystemGroupDefinition): Promise<() => Promise<void>> {
    if (this.closed) throw new ServerError('definitions_unavailable')
    validateGroup(input)
    const identity = `${input.plugin}\0${input.key}`
    if (this.identities.has(identity)) throw new ServerError('group_registration_exists')
    this.identities.add(identity)
    const pending = this.tail.then(() => this.activate(input, identity))
    this.tail = pending.then(() => {}, () => {})
    this.writes.add(pending)
    try {
      const registration = await pending
      if (this.closed) {
        await this.unregister(registration)
        throw new ServerError('definitions_unavailable')
      }
      return () => this.unregister(registration)
    } catch (cause) {
      this.identities.delete(identity)
      throw cause
    } finally {
      this.writes.delete(pending)
    }
  }

  private async activate(input: SystemGroupDefinition, identity: string): Promise<Registration> {
    if (this.closed) throw new ServerError('definitions_unavailable')
    const catalog = [...this.base]
    for (const software of input.software ?? []) {
      if (!KEY.test(software.id) || catalog.some(item => item.id === software.id)) throw new ServerError('component_registration_conflict', { component: software.id })
      validateText(software.name)
      if (software.summary !== undefined) validateText(software.summary, true)
      if (!isAbsolute(software.detectScript) || !isAbsolute(software.installScript)) throw new ServerError('component_script_path')
      const [detectScript, installScript] = await Promise.all([readFile(software.detectScript), readFile(software.installScript)])
      catalog.push({
        id: software.id, name: software.name.zh, summary: software.summary?.zh ?? '',
        name_i18n: { ...software.name }, summary_i18n: { ...(software.summary ?? { zh: '', en: '' }) },
        requires: [...(software.requires ?? [])], order: catalog.length, directory: '',
        recipe: `${input.plugin}/${input.key}/${software.id}`, detection: 'json', detectScript, installScript,
      })
    }
    for (const item of catalog) requiredSoftware(catalog, [item.id])
    const types = input.types === undefined ? this.defaults : input.types.map(type => ({
      key: `${input.plugin}/${type.key}`,
      name_i18n: { ...type.name },
      software: requiredSoftware(catalog, type.software).map(softwareView),
    }))
    const defaultType = input.types === undefined ? VACANT_TYPE : `${input.plugin}/${input.defaultType}`
    for (const registration of this.registrations.values()) {
      if (!registration.active) continue
      for (const type of types) {
        const prior = registration.types.find(item => item.key === type.key)
        if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(type)) throw new ServerError('type_definition_conflict', { type: type.key })
      }
    }
    const definition: TypeOptions = { kind: 'system', available: false, types, default_type_key: defaultType }
    const result = await this.db.query<{ id: string }>(
      `insert into server_groups (id, name, kind, plugin_id, group_key, name_i18n, sort_order, definition)
       values ($1, $2, 'system', $3, $4, $5, $6, $7)
       on conflict (plugin_id, group_key) where kind = 'system'
       do update set name = excluded.name, name_i18n = excluded.name_i18n, sort_order = excluded.sort_order, definition = excluded.definition
       returning id`,
      [randomUUID(), input.name.zh, input.plugin, input.key, JSON.stringify(input.name), input.order ?? 0, JSON.stringify(definition)],
    )
    const id = result.rows[0]?.id
    if (id === undefined) throw new ServerError('group_registration_failed')
    const registration: Registration = { identity, id, active: true, types, defaultType, catalog, leases: new Set(), drained: new Set() }
    this.registrations.set(id, registration)
    return registration
  }

  defaultOptions(): TypeOptions {
    return { kind: 'user', available: !this.closed, default_type_key: VACANT_TYPE, types: structuredClone(this.defaults) }
  }

  view(row: GroupRecord): GroupView {
    const active = this.registrations.get(row.id)
    const options = row.kind === 'user' ? this.defaultOptions()
      : active?.active ? { available: true, types: structuredClone(active.types), default_type_key: active.defaultType }
      : { available: false, types: row.definition.types ?? [], default_type_key: row.definition.default_type_key ?? '' }
    return { ...row, ...options, kind: row.kind }
  }

  async options(groupId: string | null): Promise<TypeOptions> {
    if (groupId === null) return this.defaultOptions()
    const result = await this.db.query<GroupRecord>('select id, name, kind, plugin_id, group_key, name_i18n, sort_order, definition from server_groups where id = $1', [groupId])
    const row = result.rows[0]
    if (row === undefined) throw new ServerError('group_not_found')
    return this.view(row)
  }

  async lease(groupId: string | null, key: string): Promise<TypeLease | undefined> {
    if (this.closed) return undefined
    const options = await this.options(groupId)
    if (!options.available || this.closed) return undefined
    const type = options.types.find(item => item.key === key)
    if (type === undefined) return undefined
    const registration = groupId === null ? undefined : this.registrations.get(groupId)
    if (options.kind === 'system' && !registration?.active) return undefined
    const components = requiredSoftware(registration?.catalog ?? this.base, type.software.map(item => item.id))
    const token = Symbol()
    registration?.leases.add(token)
    let released = false
    return {
      type: structuredClone(type), components,
      signature: createHash('sha256').update(JSON.stringify({ key, software: components.map(componentRevision) })).digest('hex'),
      release: () => {
        if (released) return
        released = true
        registration?.leases.delete(token)
        if (registration?.leases.size === 0) for (const resolve of registration.drained) resolve()
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.writes])
    await Promise.all([...this.registrations.values()].map(registration => this.unregister(registration)))
  }

  private unregister(registration: Registration): Promise<void> {
    if (registration.closing !== undefined) return registration.closing
    registration.active = false
    registration.closing = (async () => {
      if (registration.leases.size > 0) await new Promise<void>(resolve => { registration.drained.add(resolve) })
      if (this.registrations.get(registration.id) === registration) this.registrations.delete(registration.id)
      this.identities.delete(registration.identity)
      registration.drained.clear()
    })()
    return registration.closing
  }
}

function validateGroup(input: SystemGroupDefinition): void {
  allowedFields(input, ['plugin', 'key', 'name', 'order', 'software', 'types', 'defaultType'])
  for (const software of input.software ?? []) allowedFields(software, ['id', 'name', 'summary', 'requires', 'detectScript', 'installScript'])
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(input.plugin) || input.plugin === 'builtin' || !KEY.test(input.key)) throw new ServerError('group_definition_invalid')
  validateText(input.name)
  if (input.order !== undefined && !Number.isSafeInteger(input.order)) throw new ServerError('group_definition_invalid')
  if (input.types === undefined) {
    if (input.defaultType !== undefined) throw new ServerError('group_definition_invalid')
    return
  }
  if (input.types.length === 0 || new Set(input.types.map(type => type.key)).size !== input.types.length) throw new ServerError('group_definition_invalid')
  if (!input.types.some(type => type.key === input.defaultType)) throw new ServerError('group_definition_invalid')
  for (const type of input.types) {
    allowedFields(type, ['key', 'name', 'software'])
    if (!KEY.test(type.key)) throw new ServerError('group_definition_invalid')
    validateText(type.name)
  }
}

function allowedFields(value: object, fields: readonly string[]): void {
  for (const field of Object.keys(value)) if (!fields.includes(field)) throw new ServerError('definition_unsupported', { field })
}

function validateText(text: LocalizedText, empty = false): void {
  const limit = empty ? 2000 : 80
  if ((!empty && (text.zh.trim() === '' || text.en.trim() === '')) || text.zh.length > limit || text.en.length > limit) throw new ServerError('group_definition_invalid')
}
