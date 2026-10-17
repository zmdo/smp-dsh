/** Display text or translations. English is the fallback. */
export type Localized = string | { readonly en: string; readonly [locale: string]: string }

export interface InventoryEntry {
  entryId: string
  moduleName: string
  meta?: { title?: Localized; description?: Localized; error?: string }
  enabled: boolean
  fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
}

export interface PresetGroup {
  id: string
  name?: string
  rows: readonly { moduleName: string; enabled: boolean | 'conditional' }[]
}

export type PluginStatus = 'enabled' | 'disabled' | 'failed' | 'preset' | 'pending' | 'loading' | 'unloading'

export interface PluginRow {
  id: string
  moduleName: string
  title: string
  description: string
  status: PluginStatus
  enabledIn: readonly string[]
}

/** Compact technical names without changing the module identity. */
export function moduleShortName(moduleName: string): string {
  const bare = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return bare.replace(/^cordis:/, '').replace(/^cordis-plugin-/, '').replace(/^dsh-(?:host-|client-)?/, '')
}

function localizedText(text: Localized, active: string): string {
  if (typeof text === 'string') return text
  return text[active] ?? text.en
}

function pluginTitle(entry: InventoryEntry, active: string): string {
  const title = entry.meta?.title
  if (typeof title === 'object') return localizedText(title, active)
  return moduleShortName(title ?? entry.moduleName)
}

function pluginDescription(entry: InventoryEntry, active: string): string {
  const description = entry.meta?.description
  if (description === undefined) return ''
  return localizedText(description, active)
}

function presetNames(presets: readonly PresetGroup[], moduleName: string): string[] {
  const names: string[] = []
  for (const preset of presets) {
    if (!preset.rows.some(row => row.moduleName === moduleName && row.enabled === true)) continue
    const name = preset.name?.trim()
    names.push(name === undefined || name === '' ? preset.id : name)
  }
  return names
}

function statusOf(entry: InventoryEntry, provided: readonly string[]): PluginStatus {
  if (entry.fiberPhase === 'failed') return 'failed'
  if (!entry.enabled && provided.length > 0) return 'preset'
  if (!entry.enabled) return 'disabled'
  if (entry.fiberPhase === 'pending' || entry.fiberPhase === 'loading' || entry.fiberPhase === 'unloading') return entry.fiberPhase
  return 'enabled'
}

/** Global Loader entries, in inventory order. Preset compositions stay on the Harness page. */
export function globalRows(entries: readonly InventoryEntry[], presets: readonly PresetGroup[], active: string, query: string): PluginRow[] {
  const needle = query.trim().toLocaleLowerCase()
  const rows: PluginRow[] = []
  for (const entry of entries) {
    const title = pluginTitle(entry, active)
    const description = pluginDescription(entry, active)
    const provided = presetNames(presets, entry.moduleName)
    if (needle !== '' && ![entry.moduleName, entry.entryId, title, description].some(value => value.toLocaleLowerCase().includes(needle))) continue
    rows.push({
      id: entry.entryId,
      moduleName: entry.moduleName,
      title,
      description,
      status: statusOf(entry, provided),
      enabledIn: provided,
    })
  }
  return rows
}
