import type {
  DefinitionBundle,
  Registration,
} from '@smp/console-server-management/contracts'

const owner = '@smp/console-self-evolution'
const infrastructureType = `${owner}/infrastructure`
const testType = `${owner}/test`
const hostType = `${owner}/host`

export const selfEvolutionDefinitions: DefinitionBundle = {
  contractVersion: 2,
  owner,
  types: [
    {
      key: 'infrastructure',
      name: { zh: '自演进基础设施服务器', en: 'Self-evolution infrastructure server' },
      supportedOs: { kind: 'all' },
      requirements: [],
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
}

export const inject = ['serverManagement']

export async function apply(ctx: Ctx): Promise<void> {
  const registration = ctx.serverManagement.registerDefinitions(selfEvolutionDefinitions)
  await registration.ready
}
