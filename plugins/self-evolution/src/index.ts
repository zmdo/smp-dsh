import { fileURLToPath } from 'node:url'
import type {
  DefinitionBundle,
  RecipeDefinition,
  Registration,
  ScriptDefinition,
} from '@smp/console-server-management/contracts'

const owner = '@smp/console-self-evolution'
const runtime = '@smp/console-container-runtime'
const docker = `${runtime}/docker-engine`
const dockerRecipe = `${runtime}/docker-engine-apt`
const postgresql = `${owner}/postgresql`
const postgresqlRecipe = `${owner}/postgresql-docker`
const onedev = `${owner}/onedev`
const onedevRecipe = `${owner}/onedev-docker`
const caddy = `${owner}/caddy`
const caddyRecipe = `${owner}/caddy-docker`
const supportedOs = [{ family: 'builtin/ubuntu', versions: { kind: 'release' as const, version: '24.04' }, architectures: ['x86_64', 'aarch64'] }]
const script: ScriptDefinition = {
  path: fileURLToPath(new URL('../scripts/stack.sh', import.meta.url)),
  interpreter: 'posix-sh',
  timeoutMs: 900_000,
  outputLimitBytes: 1_048_576,
}
const recipe = (key: string, software: string, requires: RecipeDefinition['requires'] = []): RecipeDefinition => ({
  key,
  software,
  supportedOs,
  requires,
  detect: script,
  listCandidates: script,
  resolve: script,
  mutation: { actions: ['install', 'upgrade', 'replace'], execute: script, verify: script, recover: script },
})
const infrastructureType = `${owner}/infrastructure`
const testType = `${owner}/test`
const hostType = `${owner}/host`

export const selfEvolutionDefinitions: DefinitionBundle = {
  contractVersion: 2,
  owner,
  software: [
    { key: 'postgresql', name: { zh: 'PostgreSQL', en: 'PostgreSQL' }, versions: 'semver-stable' },
    { key: 'onedev', name: { zh: 'OneDev', en: 'OneDev' }, versions: 'semver-stable' },
    { key: 'caddy', name: { zh: 'Caddy', en: 'Caddy' }, versions: 'semver-stable' },
  ],
  recipes: [
    recipe('postgresql-docker', postgresql, [{ software: docker, versions: { kind: 'any' }, recipes: [dockerRecipe] }]),
    recipe('onedev-docker', onedev, [
      { software: postgresql, versions: { kind: 'any' }, recipes: [postgresqlRecipe] },
      { software: docker, versions: { kind: 'any' }, recipes: [dockerRecipe] },
    ]),
    recipe('caddy-docker', caddy, [{ software: onedev, versions: { kind: 'any' }, recipes: [onedevRecipe] }]),
  ],
  types: [
    {
      key: 'infrastructure',
      name: { zh: '自演进基础设施服务器', en: 'Self-evolution infrastructure server' },
      supportedOs: { kind: 'explicit', selectors: supportedOs },
      requirements: [
        { software: docker, versions: { kind: 'any' }, recipes: [dockerRecipe] },
        { software: postgresql, versions: { kind: 'any' }, recipes: [postgresqlRecipe] },
        { software: onedev, versions: { kind: 'any' }, recipes: [onedevRecipe] },
        { software: caddy, versions: { kind: 'any' }, recipes: [caddyRecipe] },
      ],
    },
    {
      key: 'test',
      name: { zh: '自演进测试服务器', en: 'Self-evolution test server' },
      supportedOs: { kind: 'all' },
      requirements: [],
    },
    {
      key: 'host',
      name: { zh: '自演进宿主服务器', en: 'Self-evolution host server' },
      supportedOs: { kind: 'all' },
      requirements: [],
    },
  ],
  groups: [
    {
      key: 'self-evolution',
      name: { zh: '自演进组', en: 'Self-evolution' },
      order: 10,
      types: [infrastructureType, testType, hostType],
      defaultType: infrastructureType,
    },
  ],
}

interface Ctx {
  serverManagement: {
    registerDefinitions(definition: DefinitionBundle): Registration
  }
  containerRuntime: { ready: Promise<void> }
}

export const inject = ['serverManagement', 'containerRuntime']

export async function apply(ctx: Ctx): Promise<void> {
  await ctx.containerRuntime.ready
  const registration = ctx.serverManagement.registerDefinitions(selfEvolutionDefinitions)
  await registration.ready
}
