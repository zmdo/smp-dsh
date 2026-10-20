import type {
  ExtensionCatalogEntry,
  ExtensionKind,
  ExtensionScope,
  ServerExtensionBundle,
} from '../../shared/contracts/extensions.ts'
import type { Json, LocalizedText } from '../../shared/contracts/common.ts'
import type { ServerDto } from '../../shared/dto/servers.ts'
import type { ServerExtensionRuntime } from './runtime.ts'
import { ServerError } from '../../shared/errors.ts'
import { validateOsSupport, type DeclaredOs, type DetectedOs, supportsOs } from '../../shared/operating-systems.ts'
import type { DefinitionRegistry } from '../definitions/registry.ts'

const KEY = /^[a-z][a-z0-9-]{0,63}$/
const PACKAGE = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/
const EXTENSION_KEYS = new Set(['contractVersion', 'owner', 'panels', 'settings', 'queries', 'inspections'])

interface Installed {
  owner: string
  entries: ExtensionCatalogEntry[]
  identity: object
  runtime: ServerExtensionRuntime
}

/** Metadata catalog only; component slots and persistence arrive with the panel steps. */
export class ServerExtensionRegistry {
  private readonly definitions: DefinitionRegistry
  private readonly owners = new Map<string, Installed>()
  private revision = 0
  private closed = false
  private tail: Promise<void> = Promise.resolve()

  constructor(definitions: DefinitionRegistry) {
    this.definitions = definitions
  }

  catalogRevision(): number {
    return this.revision
  }

  registerExtensions(
    input: ServerExtensionBundle,
    identity: object = input,
    runtime: ServerExtensionRuntime = {},
  ): {
    ready: Promise<void>
    dispose(): Promise<void>
  } {
    if (this.closed) throw new ServerError('definitions_unavailable')
    let record: Installed | undefined
    let cancelled = false
    const ready = this.tail.then(async () => {
      if (cancelled) return
      record = this.activate(input, identity, runtime)
      if (cancelled || this.closed) {
        this.remove(record)
        record = undefined
      }
    })
    this.tail = ready.then(
      () => {},
      () => {},
    )
    return {
      ready,
      dispose: async () => {
        cancelled = true
        await ready
        if (record !== undefined) this.remove(record)
      },
    }
  }

  list(typeKey?: string, os?: DeclaredOs | DetectedOs): readonly ExtensionCatalogEntry[] {
    return [...this.owners.values()]
      .flatMap((installed) => installed.entries)
      .filter((entry) => {
        if (typeKey !== undefined && entry.appliesTo.types !== undefined && !entry.appliesTo.types.includes(typeKey))
          return false
        if (os !== undefined && entry.appliesTo.os !== undefined && !supportsOs(entry.appliesTo.os, os))
          return false
        return true
      })
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  }

  catalogFor(server: Pick<ServerDto, 'type_key' | 'declared_os'>): readonly ExtensionCatalogEntry[] {
    return this.list(server.type_key, server.declared_os)
  }

  entry(key: string, kind: ExtensionKind): { entry: ExtensionCatalogEntry; runtime: ServerExtensionRuntime } | undefined {
    for (const installed of this.owners.values()) {
      const entry = installed.entries.find((item) => item.key === key && item.kind === kind)
      if (entry !== undefined) return { entry, runtime: installed.runtime }
    }
    return undefined
  }

  async runQuery(server: ServerDto, key: string, search: URLSearchParams): Promise<Json> {
    const found = this.entry(key, 'query')
    if (found === undefined) throw new ServerError('extension_not_found', { key })
    if (!this.applies(found.entry, server)) throw new ServerError('extension_unavailable', { key })
    const handler = found.runtime.queries?.[key.slice(found.entry.owner.length + 1)]
    if (handler === undefined) throw new ServerError('extension_query_unavailable', { key })
    return handler(server, search)
  }

  settings(server: ServerDto, key: string): { entry: ExtensionCatalogEntry; runtime: { defaults: Json; validate(value: unknown): Json } } {
    const found = this.entry(key, 'settings')
    if (found === undefined) throw new ServerError('extension_not_found', { key })
    if (!this.applies(found.entry, server)) throw new ServerError('extension_unavailable', { key })
    const handler = found.runtime.settings?.[key.slice(found.entry.owner.length + 1)]
    if (handler === undefined) throw new ServerError('extension_settings_unavailable', { key })
    return { entry: found.entry, runtime: handler }
  }

  private applies(entry: ExtensionCatalogEntry, server: Pick<ServerDto, 'type_key' | 'declared_os'>): boolean {
    if (entry.appliesTo.types !== undefined && !entry.appliesTo.types.includes(server.type_key)) return false
    if (entry.appliesTo.os !== undefined && !supportsOs(entry.appliesTo.os, server.declared_os)) return false
    return true
  }

  async close(): Promise<void> {
    this.closed = true
    this.owners.clear()
    this.revision += 1
    await Promise.allSettled([this.tail])
  }

  private activate(input: ServerExtensionBundle, identity: object, runtime: ServerExtensionRuntime): Installed {
    if (this.closed) throw new ServerError('definitions_unavailable')
    if (input.contractVersion !== 1 || !PACKAGE.test(input.owner) || input.owner === 'builtin')
      throw new ServerError('extension_definition_invalid')
    for (const key of Object.keys(input))
      if (!EXTENSION_KEYS.has(key)) throw new ServerError('extension_definition_invalid', { field: key })
    if (this.owners.has(input.owner)) throw new ServerError('extension_registration_exists')
    const entries: ExtensionCatalogEntry[] = []
    const keys = new Set<string>()
    const add = (
      kind: ExtensionKind,
      items:
        | readonly { key: string; name: LocalizedText; order?: number; appliesTo?: ExtensionScope }[]
        | undefined,
    ) => {
      for (const item of items ?? []) {
        if (!KEY.test(item.key)) throw new ServerError('extension_definition_invalid')
        const key = `${input.owner}/${item.key}`
        if (keys.has(key)) throw new ServerError('extension_definition_conflict', { key })
        validateText(item.name)
        if (kind === 'settings' && 'sensitive' in item && item.sensitive === true)
          throw new ServerError('extension_definition_invalid', { field: 'sensitive' })
        if (item.order !== undefined && !Number.isSafeInteger(item.order))
          throw new ServerError('extension_definition_invalid')
        const appliesTo = item.appliesTo ?? {}
        if (appliesTo.types !== undefined && appliesTo.types.length === 0)
          throw new ServerError('extension_definition_invalid')
        for (const type of appliesTo.types ?? []) {
          if (!this.definitions.hasType(type)) throw new ServerError('definition_reference', { detail: type })
        }
        if (appliesTo.os !== undefined) validateOsSupport(appliesTo.os, false)
        keys.add(key)
        entries.push({
          key,
          owner: input.owner,
          kind,
          name: { ...item.name },
          order: item.order ?? 0,
          appliesTo: structuredClone(appliesTo),
          ...(kind === 'settings' && 'affectsExecution' in item && item.affectsExecution === true
            ? { affectsExecution: true }
            : {}),
        })
      }
    }
    add('panel', input.panels)
    add('settings', input.settings)
    add('query', input.queries)
    add('inspection', input.inspections)
    const record: Installed = { owner: input.owner, entries, identity, runtime }
    this.owners.set(input.owner, record)
    this.revision += 1
    return record
  }

  private remove(record: Installed): void {
    if (this.owners.get(record.owner) !== record) return
    this.owners.delete(record.owner)
    this.revision += 1
  }
}

function validateText(text: LocalizedText): void {
  if (!text.zh.trim() || !text.en.trim() || text.zh.length > 80 || text.en.length > 80)
    throw new ServerError('extension_definition_invalid')
}
