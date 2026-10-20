import assert from 'node:assert/strict'
import test from 'node:test'
import type { Db } from '../src/host/database/connection.ts'
import { builtinCatalog } from '../src/host/definitions/catalog.ts'
import { DefinitionRegistry } from '../src/host/definitions/registry.ts'
import { ServerExtensionRegistry } from '../src/host/extensions/registry.ts'
import type { ServerDto } from '../src/shared/dto/servers.ts'
import type { SlotService } from '../src/client/extensions/slots.ts'
import { fixtureDefinitions, fixtureExtension, fixtureRuntime, fixtureType } from './fixtures/extension-fixture.ts'
import { registerFixtureClient } from './fixtures/extension-fixture-client.ts'

function fakeDb(): Db {
  const client = {
    async query() {
      return { rows: [] }
    },
    release() {},
  }
  return { connect: async () => client } as unknown as Db
}

function server(type_key: string): ServerDto {
  return { type_key } as ServerDto
}

test('the formal fixture contributes one database panel, setting, query and inspection', async () => {
  const definitions = new DefinitionRegistry(fakeDb(), builtinCatalog())
  const definitionsRegistration = definitions.registerDefinitions(fixtureDefinitions)
  await definitionsRegistration.ready
  const extensions = new ServerExtensionRegistry(definitions)
  const registration = extensions.registerExtensions(fixtureExtension, fixtureExtension, fixtureRuntime)
  await registration.ready
  assert.deepEqual(
    extensions.catalogFor(server('builtin/general')).map((entry) => entry.key),
    [],
  )
  assert.deepEqual(
    extensions.catalogFor(server(fixtureType)).map((entry) => `${entry.kind}:${entry.key}`),
    [
      'inspection:@test/extension-fixture/database-check',
      'panel:@test/extension-fixture/database-panel',
      'settings:@test/extension-fixture/database-settings',
      'query:@test/extension-fixture/database-status',
    ],
  )
  assert.deepEqual(await extensions.runQuery(server(fixtureType), '@test/extension-fixture/database-status', new URLSearchParams()), { online: true })
  assert.deepEqual(extensions.settings(server(fixtureType), '@test/extension-fixture/database-settings').runtime.defaults, {
    collect: true,
  })
  await assert.rejects(
    extensions.runQuery(server('builtin/general'), '@test/extension-fixture/database-status', new URLSearchParams()),
    { code: 'extension_unavailable' },
  )
  await registration.dispose()
  await definitionsRegistration.dispose()
  extensions.close()
  await definitions.close()
})

test('the fixture registers components through the public slot helpers', () => {
  const registered: { name: string; key: string }[] = []
  const slots: SlotService = {
    inject(_name, register) {
      register()
    },
    register(options) {
      const value = options as { name: string; key: string }
      registered.push(value)
      return () => {}
    },
    entriesOfSlot() {
      return []
    },
    subscribe() {
      return () => {}
    },
  }
  registerFixtureClient(slots)
  assert.deepEqual(registered, [
    { name: 'server-management.detail.panel', key: 'database-panel', priority: 0 },
    { name: 'server-management.settings.section', key: 'database-settings', priority: 0 },
  ])
})
