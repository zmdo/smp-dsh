import { fileURLToPath } from 'node:url'
import type { DefinitionBundle, RecipeDefinition, ScriptDefinition } from '@smp/console-server-management/contracts'
import type { ServerExtensionBundle } from '@smp/console-server-management/contracts'
import type { ServerExtensionRuntime } from '@smp/console-server-management/contracts'
import type { Db, ServerManagementHostContract } from '@smp/console-server-management/contracts'
import { parseContainers, type Container } from './model.ts'
import { containerSnapshot, replaceContainers, requireContainerSchema } from './persistence/containers.ts'
import { APT_SOFTWARE_OS } from './operating-systems.ts'

const owner = '@smp/console-server-containers'
const docker = `${owner}/docker-engine`
const compose = `${owner}/docker-compose`
const type = `${owner}/container`
const inspectScript: ScriptDefinition = {
  path: fileURLToPath(new URL('../scripts/inspect.sh', import.meta.url)),
  interpreter: 'posix-sh',
  timeoutMs: 30_000,
  outputLimitBytes: 65_536,
}
const script: ScriptDefinition = {
  path: fileURLToPath(new URL('../scripts/recipe.sh', import.meta.url)),
  interpreter: 'posix-sh',
  timeoutMs: 600_000,
  outputLimitBytes: 1_048_576,
}
const recipe = (key: string, software: string): RecipeDefinition => ({
  key,
  software,
  supportedOs: APT_SOFTWARE_OS,
  detect: script,
  listCandidates: script,
  resolve: script,
  mutation: {
    actions: ['install', 'upgrade', 'replace'],
    execute: script,
    verify: script,
    recover: script,
  },
})

export const containerDefinitions: DefinitionBundle = {
  contractVersion: 2,
  owner,
  software: [
    { key: 'docker-engine', name: { zh: 'Docker', en: 'Docker' }, versions: 'semver-stable' },
    { key: 'docker-compose', name: { zh: 'Docker Compose', en: 'Docker Compose' }, versions: 'semver-stable' },
  ],
  recipes: [recipe('docker-engine-apt', docker), recipe('docker-compose-apt', compose)],
  types: [
    {
      key: 'container',
      name: { zh: '容器服务器', en: 'Container server' },
      supportedOs: { kind: 'explicit', selectors: APT_SOFTWARE_OS },
      requirements: [
        { software: docker, versions: { kind: 'any' }, recipes: [`${owner}/docker-engine-apt`] },
        { software: compose, versions: { kind: 'any' }, recipes: [`${owner}/docker-compose-apt`] },
      ],
    },
  ],
  publicTypes: [{ type, order: 10 }],
}

export const containerExtensions: ServerExtensionBundle = {
  contractVersion: 1,
  owner,
  panels: [
    {
      key: 'containers',
      name: { zh: '容器', en: 'Containers' },
      appliesTo: { types: [type] },
    },
  ],
  queries: [
    {
      key: 'container-list',
      name: { zh: '容器清单', en: 'Container list' },
      appliesTo: { types: [type] },
    },
  ],
  settings: [
    {
      key: 'container-settings', revision: '1',
      name: { zh: '容器设置', en: 'Container settings' },
      appliesTo: { types: [type] },
    },
  ],
  inspections: [
    {
      key: 'container-check',
      name: { zh: '容器检查', en: 'Container check' },
      appliesTo: { types: [type] },
      settingsKey: `${owner}/container-settings`,
      script: inspectScript,
    },
  ],
}

const runtime: ServerExtensionRuntime = {
  inspections: {
    'container-check': {
      enabled: (value) => (value as { collect?: boolean } | undefined)?.collect !== false,
      validate: parseContainers,
      async commit(db, server, result) {
        await replaceContainers(db, server.id, (result as { containers: Container[] }).containers)
      },
    },
  },
  settings: {
    'container-settings': {
      defaults: { collect: true },
      validate(value) {
        if (value === null || typeof value !== 'object' || typeof (value as { collect?: unknown }).collect !== 'boolean')
          throw new Error('invalid container settings')
        return { collect: (value as { collect: boolean }).collect }
      },
    },
  },
}

interface Ctx {
  database: { pool: Pick<Db, 'query'> }
  serverManagement: ServerManagementHostContract
}

export const inject = ['serverManagement', 'database']

export async function apply(ctx: Ctx): Promise<void> {
  await requireContainerSchema(ctx.database.pool)
  const definitionsReady = ctx.serverManagement.registerDefinitions(containerDefinitions)
  await definitionsReady.ready
  const extensionRuntime: ServerExtensionRuntime = {
    ...runtime,
    queries: {
      'container-list': async (server) => ({ ...await containerSnapshot(ctx.database.pool, server.id) }),
    },
  }
  const extensionsReady = ctx.serverManagement.registerServerExtensions(containerExtensions, extensionRuntime)
  await extensionsReady.ready
}
