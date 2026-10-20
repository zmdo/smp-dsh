import type { LocalizedText, RecipeDefinition } from '../../shared/contracts.ts'
import { ServerError } from '../../shared/errors.ts'
import type { OsSelector } from '../../shared/operating-systems.ts'
import { APT_SOFTWARE_OS } from '../../shared/operating-systems.ts'
import { stableVersions, type VersionAdapter, type VersionRule } from '../../shared/versions.ts'
import { aptScript } from '../recipes/builtin.ts'
import { digest } from '../recipes/canonical.ts'
import { type LoadedScript } from '../recipes/script.ts'

export interface Component {
  id: string
  software_key: string
  name: string
  summary: string
  name_i18n: LocalizedText
  summary_i18n: LocalizedText
  supportedOs: readonly OsSelector[]
  whenOs?: readonly OsSelector[]
  requires: string[]
  recipe: string
  revision: string
  versions: VersionRule
  adapter: VersionAdapter
  scripts: {
    detect: LoadedScript
    listCandidates?: LoadedScript
    resolve?: LoadedScript
    execute?: LoadedScript
    verify?: LoadedScript
    recover?: LoadedScript
  }
  actions: readonly ('install' | 'upgrade' | 'replace')[]
}
export function componentRevision(component: Component): string {
  return component.revision
}
export class CatalogError extends ServerError {}
export function builtinCatalog(): Component[] {
  const script = aptScript()
  return ['docker', 'compose'].map((id, index) => ({
    id,
    software_key: index === 0 ? 'builtin/docker-engine' : 'builtin/docker-compose',
    name: index === 0 ? 'Docker' : 'Docker Compose',
    summary: '',
    name_i18n: {
      zh: index === 0 ? 'Docker' : 'Docker Compose',
      en: index === 0 ? 'Docker' : 'Docker Compose',
    },
    summary_i18n: { zh: '使用已配置的 apt 软件源安装。', en: 'Install from configured apt repositories.' },
    supportedOs: APT_SOFTWARE_OS,
    requires: index === 0 ? [] : ['docker'],
    recipe: `builtin/${id}-apt`,
    versions: { kind: 'any' },
    adapter: stableVersions,
    scripts: {
      detect: script,
      listCandidates: script,
      resolve: script,
      execute: script,
      verify: script,
      recover: script,
    },
    actions: ['install', 'upgrade', 'replace'],
    revision: digest({
      software: id,
      supportedOs: APT_SOFTWARE_OS,
      script,
      requires: index === 0 ? [] : ['docker'],
      versions: stableVersions.revision,
    }),
  }))
}
export function normalizeSelection(catalog: readonly Component[], ids: readonly string[]): string[] {
  const selected = new Set(ids)
  for (const id of selected) {
    const item = catalog.find((c) => c.id === id)
    if (!item) throw new CatalogError('component_unknown')
    for (const dependency of item.requires)
      if (!selected.has(dependency))
        throw new CatalogError('component_dependency', { component: id, dependency })
  }
  return catalog.filter((item) => selected.has(item.id)).map((item) => item.id)
}
export type LoadedRecipe = Omit<RecipeDefinition, 'detect' | 'listCandidates' | 'resolve' | 'mutation'> & {
  revision: string
  scripts: Component['scripts']
  actions: Component['actions']
}

export function componentView(
  catalog: readonly Component[],
): { id: string; name: string; summary: string; requires: string[] }[] {
  return catalog.map((item) => ({
    id: item.id,
    name: item.name,
    summary: item.summary,
    requires: item.requires,
  }))
}
