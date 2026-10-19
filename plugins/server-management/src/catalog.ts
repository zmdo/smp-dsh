import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ServerError, serverCopy, type ErrorCode, type MessageParams } from './i18n.ts'
import type { LocalizedText } from './definitions.ts'

export interface Component {
  id: string
  name: string
  summary: string
  order: number
  requires: string[]
  directory: string
  recipe: string
  detection: 'builtin' | 'json'
  name_i18n: LocalizedText
  summary_i18n: LocalizedText
  detectScript: Buffer
  installScript: Buffer
}

export function componentRevision(item: Component): string {
  return createHash('sha256').update(JSON.stringify({ id: item.id, recipe: item.recipe, requires: item.requires }))
    .update(item.detectScript).update(item.installScript).digest('hex')
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
    const builtin = id === 'docker' || id === 'compose'
    const fallback = { name: String(meta.name ?? id), summary: String(meta.summary ?? '') }
    const zh = builtin ? serverCopy('zh').components[id] : fallback
    const en = builtin ? serverCopy('en').components[id] : fallback
    const [detectScript, installScript] = await Promise.all([readFile(join(directory, 'detect.sh')), readFile(join(directory, 'install.sh'))])
    found.push({
      id,
      name: String(meta.name ?? id),
      summary: String(meta.summary ?? ''),
      order: Number(meta.order ?? 0),
      requires,
      directory,
      recipe: `builtin/${id}`,
      detection: builtin ? 'builtin' : 'json',
      name_i18n: { zh: zh.name, en: en.name },
      summary_i18n: { zh: zh.summary, en: en.summary },
      detectScript,
      installScript,
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
