import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Db } from '../src/host/database/connection.ts'
import { builtinCatalog } from '../src/host/definitions/catalog.ts'
import { DefinitionRegistry } from '../src/host/definitions/registry.ts'
import { ServerManagement } from '../src/host/definitions/service.ts'
import { ServerExtensionRegistry } from '../src/host/extensions/registry.ts'
import type { ServerExtensionBundle } from '../src/shared/contracts/extensions.ts'

const bundle: ServerExtensionBundle = {
  contractVersion: 1,
  owner: '@test/ext',
  panels: [
    {
      key: 'database',
      name: { zh: '数据库管理', en: 'Database management' },
      appliesTo: { types: ['builtin/general'] },
    },
  ],
  settings: [
    {
      key: 'database-settings',
      name: { zh: '数据库设置', en: 'Database settings' },
      appliesTo: { types: ['builtin/general'] },
    },
  ],
  queries: [
    {
      key: 'database-status',
      name: { zh: '数据库状态', en: 'Database status' },
      appliesTo: { types: ['builtin/general'] },
    },
  ],
  inspections: [
    {
      key: 'database-check',
      name: { zh: '数据库检查', en: 'Database check' },
      appliesTo: { types: ['builtin/general'] },
    },
  ],
}

const noDb = {} as Db

test('extension metadata is filtered by type and is removed on dispose', async () => {
  const definitions = new DefinitionRegistry(noDb, builtinCatalog())
  const extensions = new ServerExtensionRegistry(definitions)
  const registration = extensions.registerExtensions(bundle)
  await registration.ready
  assert.equal(extensions.list('builtin/general').length, 4)
  assert.equal(extensions.list('builtin/vacant').length, 0)
  assert.equal(extensions.list().length, 4)
  const revision = extensions.catalogRevision()
  await registration.dispose()
  assert.equal(extensions.list().length, 0)
  assert.ok(extensions.catalogRevision() > revision)
  extensions.close()
})

test('unknown type references and duplicate owners or keys are rejected atomically', async () => {
  const definitions = new DefinitionRegistry(noDb, builtinCatalog())
  const extensions = new ServerExtensionRegistry(definitions)
  const missing = extensions.registerExtensions({
    ...bundle,
    panels: [{ key: 'missing', name: { zh: '缺失', en: 'Missing' }, appliesTo: { types: ['@test/missing/type'] } }],
  } as ServerExtensionBundle)
  await assert.rejects(missing.ready, { code: 'definition_reference' })
  const duplicateKeys = extensions.registerExtensions({
    contractVersion: 1,
    owner: '@test/duplicate',
    panels: [{ key: 'same', name: { zh: '一', en: 'One' } }],
    settings: [{ key: 'same', name: { zh: '二', en: 'Two' } }],
  })
  await assert.rejects(duplicateKeys.ready, { code: 'extension_definition_conflict' })
  const first = extensions.registerExtensions(bundle)
  await first.ready
  const second = extensions.registerExtensions(bundle)
  await assert.rejects(second.ready, { code: 'extension_registration_exists' })
  await first.dispose()
  extensions.close()
})

test('Cordis ownership is checked and unload removes the extension catalog', async () => {
  const definitions = new DefinitionRegistry(noDb, builtinCatalog())
  const extensions = new ServerExtensionRegistry(definitions)
  const root = new Context()
  const provided = root.provide('serverManagement', new ServerManagement(root, definitions, extensions))
  const fiber = root.plugin({
    name: '@test/ext',
    inject: ['serverManagement'],
    async apply(ctx: Context) {
      const registration = ctx.serverManagement.registerServerExtensions(bundle)
      await registration.ready
    },
  })
  await fiber
  assert.equal(extensions.list().length, 4)
  await fiber.dispose()
  assert.equal(extensions.list().length, 0)
  assert.throws(() => root.serverManagement.registerServerExtensions(bundle), { code: 'definition_owner' })
  await provided()
  extensions.close()
})
