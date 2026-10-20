import { fileURLToPath } from 'node:url'
import type { DefinitionBundle, RecipeDefinition, ScriptDefinition } from '../../server-management/src/shared/contracts/definitions.ts'
import type { ServerExtensionBundle } from '../../server-management/src/shared/contracts/extensions.ts'
import type { ServerExtensionRuntime } from '../../server-management/src/host/extensions/runtime.ts'
import { APT_SOFTWARE_OS } from '../../server-management/src/shared/operating-systems.ts'

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
      key: 'container-settings',
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
      validate: (raw) => JSON.parse(raw),
    },
  },
  settings: {
    'container-settings': {
      defaults: { collect: true },
      validate(value) {
        if (value === null || typeof value !== 'object' || typeof (value as { collect?: unknown }).collect !== 'boolean')
          throw new Error('invalid container settings')
        return value
      },
    },
  },
}

interface Ctx {
  database: { pool: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> } }
  serverManagement: {
    registerDefinitions(input: DefinitionBundle): { ready: Promise<void> }
    registerServerExtensions(input: ServerExtensionBundle, runtime?: ServerExtensionRuntime): { ready: Promise<void> }
  }
}

export const inject = ['serverManagement', 'database']

export async function apply(ctx: Ctx): Promise<void> {
  const definitionsReady = ctx.serverManagement.registerDefinitions(containerDefinitions)
  await definitionsReady.ready
  const extensionRuntime: ServerExtensionRuntime = {
    ...runtime,
    queries: {
      'container-list': async (server) => ({
        rows: (await ctx.database.pool.query(
          'select container_id,name,image,status,ports from server_containers where server_id=$1 order by name',
          [server.id],
        )).rows,
      }),
    },
  }
  const extensionsReady = ctx.serverManagement.registerServerExtensions(containerExtensions, extensionRuntime)
  await extensionsReady.ready
}
