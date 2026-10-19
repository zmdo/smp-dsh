import { randomUUID } from 'node:crypto'
import type {
  DefinitionBundle,
  Registration as RegistrationHandle,
  RecipeDefinition,
  ServerTypeDefinition,
  SoftwareDefinition,
  SoftwareRequirement,
  SystemGroupDefinition,
} from './contracts.ts'
import { CatalogError, componentRevision, type Component, type LoadedRecipe } from './catalog.ts'
import {
  GENERAL_TYPE,
  VACANT_TYPE,
  type GroupRecord,
  type GroupView,
  type LocalizedText,
  type ServerTypeView,
  type SoftwareView,
  type TypeOptions,
} from './definitions.ts'
import { ServerError } from './i18n.ts'
import type { Db } from './store.ts'
import {
  APT_SOFTWARE_OS,
  OS_CATALOG,
  supportsOs,
  validateOsSupport,
  type DeclaredOs,
  type DetectedOs,
} from './operating-systems.ts'
import { digest, loadScript } from './recipe.ts'
import { stableVersions, type VersionAdapter, type VersionRule } from './versions.ts'

interface Owner {
  identity: object
  owner: string
  active: boolean
  software: Map<string, SoftwareDefinition>
  recipes: Map<string, LoadedRecipe>
  types: Map<string, ServerTypeDefinition>
  groups: Map<string, SystemGroupDefinition>
  dependencies: Set<Owner>
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
const PACKAGE = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/
export function softwareView(item: Component): SoftwareView {
  return {
    id: item.id,
    software_key: item.software_key,
    supportedOs: item.supportedOs,
    whenOs: item.whenOs,
    name: item.name,
    summary: item.summary,
    name_i18n: item.name_i18n,
    summary_i18n: item.summary_i18n,
    requires: [...item.requires],
    recipe: item.recipe,
    revision: componentRevision(item),
    versions: item.versions,
  }
}
export function requiredSoftware(catalog: readonly Component[], ids: readonly string[]): Component[] {
  const byId = new Map(catalog.map((item) => [item.id, item])),
    visiting = new Set<string>(),
    visited = new Set<string>(),
    result: Component[] = []
  const visit = (id: string) => {
    if (visited.has(id)) return
    const item = byId.get(id)
    if (!item) throw new CatalogError('component_unknown', { component: id })
    if (visiting.has(id)) throw new CatalogError('component_cycle', { component: id })
    visiting.add(id)
    for (const dep of item.requires) visit(dep)
    visiting.delete(id)
    visited.add(id)
    result.push(item)
  }
  for (const id of ids) visit(id)
  return result
}
export function builtinTypes(catalog: readonly Component[]): readonly ServerTypeView[] {
  return [
    {
      key: VACANT_TYPE,
      name_i18n: { zh: '空置服务器', en: 'Vacant server' },
      software: [],
      supportedOs: { kind: 'all' },
    },
    {
      key: GENERAL_TYPE,
      name_i18n: { zh: '普通服务器', en: 'General-purpose server' },
      supportedOs: { kind: 'explicit', selectors: APT_SOFTWARE_OS },
      software: requiredSoftware(catalog, ['docker', 'compose']).map(softwareView),
    },
  ]
}

/** Registrations are atomic. Each lease pins every provider used by the type, including transitive dependencies. */
export class DefinitionRegistry {
  private readonly owners = new Map<string, Owner>()
  private readonly pending = new Set<Promise<unknown>>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly db: Db
  private readonly base: readonly Component[]
  constructor(db: Db, base: readonly Component[]) {
    this.db = db
    this.base = base
  }

  registerDefinitions(input: DefinitionBundle, identity: object = input): RegistrationHandle {
    if (this.closed) throw new ServerError('definitions_unavailable')
    // Snapshot metadata now; adapter functions are captured separately and included in the semantic digest.
    const bundle = {
      ...structuredClone({ ...input, software: undefined }),
      software: input.software?.map((s) => ({
        ...s,
        name: { ...s.name },
        versions: typeof s.versions === 'string' ? s.versions : Object.freeze({ ...s.versions }),
      })),
    }
    let record: Owner | undefined,
      cancelled = false
    const ready = this.tail.then(async () => {
      if (cancelled) return
      record = await this.activate(bundle, identity)
      if (cancelled || this.closed) await this.unregister(record)
    })
    this.tail = ready.then(
      () => {},
      () => {},
    )
    this.pending.add(ready)
    void ready.finally(() => this.pending.delete(ready)).catch(() => {})
    return {
      ready,
      dispose: async () => {
        cancelled = true
        await ready
        if (record) await this.unregister(record)
      },
    }
  }

  private async activate(input: DefinitionBundle, identity: object): Promise<Owner> {
    if (this.closed) throw new ServerError('definitions_unavailable')
    if (input.contractVersion !== 2 || !PACKAGE.test(input.owner) || input.owner === 'builtin')
      throw new ServerError('group_definition_invalid')
    if (this.owners.has(input.owner)) throw new ServerError('group_registration_exists')
    // Custom OS identities need their own probe lifecycle. Reject unsupported capabilities instead of publishing unusable definitions.
    if (input.operatingSystems?.length) throw new ServerError('definition_unsupported', { field: 'operatingSystems' })
    const owner: Owner = {
      owner: input.owner,
      identity,
      active: true,
      software: new Map(),
      recipes: new Map(),
      types: new Map(),
      groups: new Map(),
      dependencies: new Set(),
      leases: new Set(),
      drained: new Set(),
    }
    const qualify = (key: string) => {
      if (!KEY.test(key)) throw new ServerError('group_definition_invalid')
      return `${input.owner}/${key}`
    }
    for (const software of input.software ?? []) {
      const key = qualify(software.key)
      validateText(software.name)
      if (owner.software.has(key)) throw new ServerError('component_registration_conflict', { component: key })
      owner.software.set(key, { ...software, key })
      adapterOf(software).validate({ kind: 'any' })
    }
    for (const recipe of input.recipes ?? []) {
      const key = qualify(recipe.key)
      if (owner.recipes.has(key)) throw new ServerError('component_registration_conflict', { component: key })
      validateOsSupport({ kind: 'explicit', selectors: recipe.supportedOs }, true)
      if (recipe.mutation && (!recipe.listCandidates || !recipe.resolve || !recipe.mutation.actions.length))
        throw new ServerError('recipe_unavailable')
      const scripts: Component['scripts'] = { detect: await loadScript(recipe.detect) }
      if (recipe.listCandidates) scripts.listCandidates = await loadScript(recipe.listCandidates)
      if (recipe.resolve) scripts.resolve = await loadScript(recipe.resolve)
      if (recipe.mutation) {
        scripts.execute = await loadScript(recipe.mutation.execute)
        scripts.verify = await loadScript(recipe.mutation.verify)
        scripts.recover = await loadScript(recipe.mutation.recover)
      }
      if (Object.values(scripts).some((script) => script.interpreter !== 'posix-sh'))
        throw new ServerError('definition_unsupported', { field: 'powershell mutation/detection recipes' })
      const loaded: LoadedRecipe = {
        key,
        software: recipe.software,
        supportedOs: recipe.supportedOs,
        requires: recipe.requires,
        scripts,
        actions: recipe.mutation?.actions ?? [],
        revision: digest({
          key,
          software: recipe.software,
          supportedOs: recipe.supportedOs,
          requires: recipe.requires,
          scripts,
          actions: recipe.mutation?.actions ?? [],
        }),
      }
      owner.recipes.set(key, loaded)
    }
    for (const type of input.types ?? []) {
      const key = qualify(type.key)
      if (owner.types.has(key)) throw new ServerError('type_definition_conflict', { type: key })
      validateText(type.name)
      validateOsSupport(type.supportedOs, type.requirements.length > 0)
      owner.types.set(key, { ...type, key })
    }
    for (const group of input.groups ?? []) {
      qualify(group.key)
      validateText(group.name)
      if (owner.groups.has(group.key) || group.types?.length === 0) throw new ServerError('group_definition_invalid')
      if (group.order !== undefined && !Number.isSafeInteger(group.order))
        throw new ServerError('group_definition_invalid')
      owner.groups.set(group.key, group)
    }
    const available = new Map(this.owners)
    available.set(owner.owner, owner)
    for (const recipe of owner.recipes.values()) {
      this.software(recipe.software, owner, available)
      this.components(recipe.requires ?? [], owner, available)
    }
    for (const key of owner.types.keys()) this.resolveType(key, owner, available)
    for (const group of owner.groups.values()) {
      const keys = group.types ?? [VACANT_TYPE, GENERAL_TYPE],
        fallback = group.defaultType ?? keys[0]!
      if (!keys.includes(fallback)) throw new ServerError('group_definition_invalid')
      for (const key of keys) this.resolveType(key, owner, available)
      for (const rule of group.defaultTypeByOs ?? []) {
        if (!keys.includes(rule.type)) throw new ServerError('group_definition_invalid')
        validateOsSupport({ kind: 'explicit', selectors: rule.whenOs }, false)
      }
    }
    const client = await this.db.connect()
    const saved = new Map<string, SystemGroupDefinition>()
    try {
      await client.query('begin')
      for (const group of owner.groups.values()) {
        const definition = this.groupOptions(group, owner, available)
        const row = (
          await client.query<{ id: string }>(
            `insert into server_groups(id,name,kind,plugin_id,group_key,name_i18n,sort_order,definition)
          values($1,$2,'system',$3,$4,$5,$6,$7) on conflict(plugin_id,group_key) where kind='system'
          do update set name=excluded.name,name_i18n=excluded.name_i18n,sort_order=excluded.sort_order,definition=excluded.definition returning id`,
            [
              randomUUID(),
              group.name.zh,
              input.owner,
              group.key,
              JSON.stringify(group.name),
              group.order ?? 0,
              JSON.stringify({ ...definition, available: false }),
            ],
          )
        ).rows[0]!
        saved.set(row.id, group)
      }
      if (this.closed || [...owner.dependencies].some((p) => !this.isAvailable(p)))
        throw new ServerError('definitions_unavailable')
      await client.query('commit')
    } catch (cause) {
      await client.query('rollback')
      throw cause
    } finally {
      client.release()
    }
    owner.groups = saved
    this.owners.set(owner.owner, owner)
    return owner
  }

  private isAvailable(owner: Owner, seen = new Set<Owner>()): boolean {
    if (seen.has(owner)) return true
    seen.add(owner)
    return owner.active && [...owner.dependencies].every((dep) => this.isAvailable(dep, seen))
  }
  private find<T>(
    key: string,
    map: 'software' | 'recipes' | 'types',
    requester: Owner | undefined,
    owners: Map<string, Owner>,
  ): T {
    for (const owner of owners.values()) {
      const value = owner[map].get(key)
      if (value !== undefined && this.isAvailable(owner)) {
        if (requester && requester !== owner) requester.dependencies.add(owner)
        return value as T
      }
    }
    throw new ServerError('definition_reference', { detail: key })
  }
  private software(
    key: string,
    requester: Owner | undefined,
    owners: Map<string, Owner>,
  ): { name: LocalizedText; adapter: VersionAdapter } {
    const builtin = this.base.find((item) => item.software_key === key)
    if (builtin) return { name: builtin.name_i18n, adapter: builtin.adapter }
    const software = this.find<SoftwareDefinition>(key, 'software', requester, owners)
    return { name: software.name, adapter: adapterOf(software) }
  }
  private components(
    requirements: readonly SoftwareRequirement[],
    requester: Owner | undefined,
    owners: Map<string, Owner>,
    os?: DeclaredOs | DetectedOs,
  ): Component[] {
    const result = new Map<string, Component>(),
      visiting = new Set<string>()
    const visit = (requirement: SoftwareRequirement) => {
      if (os && requirement.whenOs && !supportsOs({ kind: 'explicit', selectors: requirement.whenOs }, os)) return
      if (visiting.has(requirement.software))
        throw new CatalogError('component_cycle', { component: requirement.software })
      const software = this.software(requirement.software, requester, owners)
      software.adapter.validate(requirement.versions)
      const recipeCandidates: LoadedRecipe[] = requirement.recipes.map((key) => {
        const builtin = this.base.find((item) => item.recipe === key)
        if (builtin)
          return {
            key,
            software: builtin.software_key,
            supportedOs: builtin.supportedOs,
            requires: builtin.requires.map((id) => {
              const dependency = this.base.find((item) => item.id === id)!
              return {
                software: dependency.software_key,
                recipes: [dependency.recipe],
                versions: { kind: 'any' } as VersionRule,
              }
            }),
            scripts: builtin.scripts,
            actions: builtin.actions,
            revision: builtin.revision,
          }
        return this.find<LoadedRecipe>(key, 'recipes', requester, owners)
      })
      if (!recipeCandidates.length || recipeCandidates.some((recipe) => recipe.software !== requirement.software))
        throw new ServerError('definition_reference')
      const recipe = recipeCandidates.find(
        (item) => !os || supportsOs({ kind: 'explicit', selectors: item.supportedOs }, os),
      )
      if (!recipe) throw new ServerError('recipe_unavailable')
      const previous = result.get(requirement.software)
      const versions = software.adapter.intersect([requirement.versions, ...(previous ? [previous.versions] : [])])
      if (!versions || (previous && previous.recipe !== recipe.key)) throw new ServerError('definition_reference')
      visiting.add(requirement.software)
      for (const dependency of recipe.requires ?? []) visit(dependency)
      visiting.delete(requirement.software)
      const builtin = this.base.find((item) => item.software_key === requirement.software)
      const adapterRevision = digest(
        Object.fromEntries(
          Object.entries(software.adapter).map(([k, v]) => [k, typeof v === 'function' ? v.toString() : v]),
        ),
      )
      const component: Component = {
        id: builtin?.id ?? requirement.software,
        software_key: requirement.software,
        name: software.name.zh,
        summary: '',
        name_i18n: software.name,
        summary_i18n: { zh: '', en: '' },
        whenOs: requirement.whenOs,
        supportedOs: os ? recipe.supportedOs : recipeCandidates.flatMap((r) => r.supportedOs),
        requires: (recipe.requires ?? [])
          .filter((r) => !os || !r.whenOs || supportsOs({ kind: 'explicit', selectors: r.whenOs }, os))
          .map((r) => this.base.find((c) => c.software_key === r.software)?.id ?? r.software),
        recipe: recipe.key,
        revision: digest({ recipe: recipe.revision, versions, adapterRevision }),
        scripts: recipe.scripts,
        versions,
        adapter: software.adapter,
        actions: recipe.actions,
      }
      result.set(requirement.software, component)
    }
    for (const requirement of requirements) visit(requirement)
    return requiredSoftware(
      [...result.values()],
      [...result.values()].map((item) => item.id),
    )
  }
  private resolveType(
    key: string,
    requester: Owner | undefined,
    owners = this.owners,
    os?: DeclaredOs | DetectedOs,
  ): { type: ServerTypeView; components: readonly Component[] } {
    const builtin = builtinTypes(this.base).find((type) => type.key === key)
    if (builtin) return { type: builtin, components: key === VACANT_TYPE ? [] : this.base }
    const type = this.find<ServerTypeDefinition>(key, 'types', requester, owners)
    const components = this.components(type.requirements, requester, owners, os)
    return {
      type: { key, name_i18n: type.name, supportedOs: type.supportedOs, software: components.map(softwareView) },
      components,
    }
  }
  private groupOptions(
    group: SystemGroupDefinition,
    owner: Owner,
    owners = this.owners,
    os?: DeclaredOs | DetectedOs,
  ): TypeOptions {
    const keys = group.types ?? [VACANT_TYPE, GENERAL_TYPE]
    const types = keys.map((key) => this.resolveType(key, owner, owners).type)
    const selected = os
      ? group.defaultTypeByOs?.find((rule) => supportsOs({ kind: 'explicit', selectors: rule.whenOs }, os))?.type
      : undefined
    return {
      kind: 'system',
      available: this.isAvailable(owner),
      default_type_key: selected ?? group.defaultType ?? keys[0]!,
      default_type_by_os: group.defaultTypeByOs,
      types,
    }
  }
  defaultOptions(): TypeOptions {
    return {
      kind: 'user',
      available: !this.closed,
      default_type_key: VACANT_TYPE,
      types: structuredClone(builtinTypes(this.base)),
    }
  }
  view(row: GroupRecord, os?: DeclaredOs | DetectedOs): GroupView {
    const owner = row.plugin_id ? this.owners.get(row.plugin_id) : undefined,
      group = owner?.groups.get(row.id)
    const options =
      row.kind === 'user'
        ? this.defaultOptions()
        : owner && group && this.isAvailable(owner)
          ? this.groupOptions(group, owner, this.owners, os)
          : {
              kind: 'system' as const,
              available: false,
              types: row.definition.types ?? [],
              default_type_key: row.definition.default_type_key ?? '',
            }
    return { ...row, ...options }
  }
  async options(groupId: string | null, os?: DeclaredOs | DetectedOs): Promise<TypeOptions> {
    if (groupId === null) return this.defaultOptions()
    const row = (await this.db.query<GroupRecord>('select * from server_groups where id=$1', [groupId])).rows[0]
    if (!row) throw new ServerError('group_not_found')
    return this.view(row, os)
  }
  /** Read all rows synchronously after the database snapshot; no execution lease or script is exposed. */
  describeType(group: GroupRecord | null, key: string, os: DeclaredOs | DetectedOs) {
    if (this.closed) return
    const options = group ? this.view(group) : this.defaultOptions()
    if (!options.available || !options.types.some(type => type.key === key)) return
    const owner = group?.plugin_id ? this.owners.get(group.plugin_id) : undefined
    const { type, components } = this.resolveType(key, owner, this.owners, os)
    return { type, components: components.map(component => ({
      software_key: component.software_key, adapter: component.adapter, versions: component.versions,
    })) }
  }
  async lease(groupId: string | null, key: string, os?: DeclaredOs | DetectedOs): Promise<TypeLease | undefined> {
    if (this.closed) return
    const options = await this.options(groupId)
    if (this.closed || !options.available || !options.types.some((type) => type.key === key)) return
    const owner = [...this.owners.values()].find((o) => groupId !== null && o.groups.has(groupId))
    const { type, components } = this.resolveType(key, owner, this.owners, os)
    const providers = new Set<Owner>()
    const collect = (item: Owner) => {
      if (providers.has(item)) return
      providers.add(item)
      for (const dep of item.dependencies) collect(dep)
    }
    if (owner) collect(owner)
    if ([...providers].some((item) => !this.isAvailable(item))) return
    const token = Symbol()
    for (const item of providers) item.leases.add(token)
    let released = false
    return {
      type: structuredClone(type),
      components,
      signature: digest({
        key,
        supportedOs: type.supportedOs,
        software: components.map((c) => ({ software: c.software_key, revision: c.revision })),
      }),
      release() {
        if (released) return
        released = true
        for (const item of providers) {
          item.leases.delete(token)
          if (!item.leases.size) for (const resolve of item.drained) resolve()
        }
      },
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.pending])
    await Promise.all([...this.owners.values()].map((owner) => this.unregister(owner)))
  }
  private unregister(owner: Owner): Promise<void> {
    if (owner.closing) return owner.closing
    owner.active = false
    owner.closing = (async () => {
      if (owner.leases.size) await new Promise<void>((resolve) => owner.drained.add(resolve))
      if (this.owners.get(owner.owner) === owner) this.owners.delete(owner.owner)
      owner.drained.clear()
    })()
    return owner.closing
  }
}
function adapterOf(software: SoftwareDefinition): VersionAdapter {
  return software.versions === 'semver-stable' ? stableVersions : software.versions
}
function validateText(text: LocalizedText): void {
  if (!text.zh.trim() || !text.en.trim() || text.zh.length > 80 || text.en.length > 80)
    throw new ServerError('group_definition_invalid')
}
