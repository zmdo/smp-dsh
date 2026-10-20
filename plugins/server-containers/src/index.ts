import type { DefinitionBundle } from '../../server-management/src/shared/contracts/definitions.ts'
import type { ServerExtensionBundle } from '../../server-management/src/shared/contracts/extensions.ts'

const owner = '@smp/console-server-containers'
const type = `${owner}/container`

const definitions: DefinitionBundle = {
  contractVersion: 2,
  owner,
  types: [
    {
      key: 'container',
      name: { zh: '容器服务器', en: 'Container server' },
      supportedOs: { kind: 'all' },
      requirements: [],
    },
  ],
  publicTypes: [{ type, order: 10 }],
}

const extensions: ServerExtensionBundle = {
  contractVersion: 1,
  owner,
  panels: [
    {
      key: 'containers',
      name: { zh: '容器', en: 'Containers' },
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
}

interface Ctx {
  serverManagement: {
    registerDefinitions(input: DefinitionBundle): { ready: Promise<void> }
    registerServerExtensions(input: ServerExtensionBundle): { ready: Promise<void> }
  }
}

export const inject = ['serverManagement']

export async function apply(ctx: Ctx): Promise<void> {
  const definitionsReady = ctx.serverManagement.registerDefinitions(definitions)
  await definitionsReady.ready
  const extensionsReady = ctx.serverManagement.registerServerExtensions(extensions)
  await extensionsReady.ready
}
