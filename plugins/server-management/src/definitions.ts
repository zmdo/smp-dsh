export interface LocalizedText {
  zh: string
  en: string
}

export interface SoftwareDefinition {
  id: string
  name: LocalizedText
  summary?: LocalizedText
  requires?: readonly string[]
  detectScript: string
  installScript: string
}

export interface ServerTypeDefinition {
  key: string
  name: LocalizedText
  software: readonly string[]
}

export interface SystemGroupDefinition {
  plugin: string
  key: string
  name: LocalizedText
  order?: number
  software?: readonly SoftwareDefinition[]
  types?: readonly ServerTypeDefinition[]
  defaultType?: string
}

export interface SoftwareView {
  id: string
  name: string
  summary: string
  name_i18n: LocalizedText
  summary_i18n: LocalizedText
  requires: readonly string[]
  recipe: string
  revision: string
}

export interface ServerTypeView {
  key: string
  name_i18n: LocalizedText
  software: readonly SoftwareView[]
}

export interface TypeOptions {
  kind: 'user' | 'system'
  available: boolean
  default_type_key: string
  types: readonly ServerTypeView[]
}

export interface GroupRecord {
  id: string
  name: string
  kind: 'user' | 'system'
  plugin_id: string | null
  group_key: string | null
  name_i18n: LocalizedText | null
  sort_order: number
  definition: TypeOptions
  server_count?: number
}

export interface GroupView extends GroupRecord, TypeOptions {}

export const VACANT_TYPE = 'builtin/vacant'
export const GENERAL_TYPE = 'builtin/general'

export function localized(text: LocalizedText, active: string): string {
  return active === 'zh' ? text.zh : text.en
}

export function sameSoftware(left: ServerTypeView, right: ServerTypeView): boolean {
  const signature = (type: ServerTypeView) => type.software.map(item => `${item.id}\0${item.recipe}\0${item.revision}`).sort().join('\n')
  return signature(left) === signature(right)
}
