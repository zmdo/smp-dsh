import { fileURLToPath } from 'node:url'
import type { DefinitionBundle } from '../../src/shared/contracts/definitions.ts'
import type { ServerExtensionBundle } from '../../src/shared/contracts/extensions.ts'
import type { ServerExtensionRuntime } from '../../src/host/extensions/runtime.ts'
import type { ServerDto } from '../../src/shared/dto/servers.ts'

export const fixtureType = '@test/extension-fixture/database'

export const fixtureDefinitions: DefinitionBundle = {
  contractVersion: 2,
  owner: '@test/extension-fixture',
  types: [
    {
      key: 'database',
      name: { zh: '数据库服务器', en: 'Database server' },
      supportedOs: { kind: 'all' },
      requirements: [],
    },
  ],
  publicTypes: [{ type: fixtureType, order: 10 }],
}

export const fixtureExtension: ServerExtensionBundle = {
  contractVersion: 1,
  owner: '@test/extension-fixture',
  panels: [
    {
      key: 'database-panel',
      name: { zh: '数据库管理', en: 'Database management' },
      appliesTo: { types: [fixtureType] },
    },
  ],
  settings: [
    {
      key: 'database-settings',
      name: { zh: '数据库设置', en: 'Database settings' },
      appliesTo: { types: [fixtureType] },
    },
  ],
  queries: [
    {
      key: 'database-status',
      name: { zh: '数据库状态', en: 'Database status' },
      appliesTo: { types: [fixtureType] },
    },
  ],
  inspections: [
    {
      key: 'database-check',
      name: { zh: '数据库检查', en: 'Database check' },
      appliesTo: { types: [fixtureType] },
      script: {
        path: fileURLToPath(new URL('./inspection.sh', import.meta.url)),
        interpreter: 'posix-sh',
        timeoutMs: 1000,
        outputLimitBytes: 4096,
      },
    },
  ],
}

export const fixtureRuntime: ServerExtensionRuntime = {
  queries: {
    'database-status': async () => ({ online: true }),
  },
  inspections: {
    'database-check': { validate: (raw) => JSON.parse(raw) },
  },
  settings: {
    'database-settings': {
      defaults: { collect: true },
      validate(value) {
        if (value === null || typeof value !== 'object' || typeof (value as { collect?: unknown }).collect !== 'boolean')
          throw new Error('invalid fixture settings')
        return value
      },
    },
  },
}
