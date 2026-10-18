import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ServerError, type ErrorCode, type MessageParams } from './i18n.ts'

export interface Component {
  id: string
  name: string
  summary: string
  order: number
  requires: string[]
  directory: string
}

export class CatalogError extends ServerError {
  constructor(code: ErrorCode, params: MessageParams = {}, options?: ErrorOptions) {
    super(code, params, options)
    this.name = 'CatalogError'
  }
}

/** Read component.json folders. The directory itself must already exist. */
export async function loadCatalog(root: string): Promise<Component[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (cause) {
    throw new CatalogError('component_directory', { directory: root }, { cause })
  }
  const found: Component[] = []
  for (const name of names.sort()) {
    const directory = join(root, name)
    let raw: string
    try {
      raw = await readFile(join(directory, 'component.json'), 'utf8')
    } catch (cause) {
      void cause
      continue
    }
    const meta = JSON.parse(raw) as { id?: unknown; name?: unknown; summary?: unknown; order?: unknown; requires?: unknown }
    const id = String(meta.id ?? '')
    if (id !== name) throw new CatalogError('component_id', { component: name })
    const requires = Array.isArray(meta.requires) ? meta.requires.map(item => String(item)) : []
    found.push({
      id,
      name: String(meta.name ?? id),
      summary: String(meta.summary ?? ''),
      order: Number(meta.order ?? 0),
      requires,
      directory,
    })
  }
  found.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  return found
}

/** Keep the catalog order and refuse an unknown id or a missing requirement. */
export function normalizeSelection(catalog: readonly Component[], componentIds: readonly string[]): string[] {
  const byId = new Map(catalog.map(item => [item.id, item]))
  const chosen: string[] = []
  for (const id of componentIds) {
    if (!byId.has(id)) throw new CatalogError('component_unknown')
    if (!chosen.includes(id)) chosen.push(id)
  }
  for (const id of chosen) {
    const component = byId.get(id)
    if (component === undefined) continue
    for (const required of component.requires) {
      if (!chosen.includes(required)) {
        throw new CatalogError('component_dependency', { component: component.id, dependency: required })
      }
    }
  }
  const order = new Map(catalog.map((item, index) => [item.id, index]))
  chosen.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
  return chosen
}
