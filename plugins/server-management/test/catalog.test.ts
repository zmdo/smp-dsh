import assert from 'node:assert/strict'
import test from 'node:test'
import {builtinCatalog,normalizeSelection} from '../src/host/definitions/catalog.ts'
test('built-in recipes have exact planning capabilities and preserve dependency order', () => {
  const catalog = builtinCatalog()
  assert.deepEqual(normalizeSelection(catalog, ['compose', 'docker']), ['docker', 'compose'])
  assert.throws(() => normalizeSelection(catalog, ['compose']))
  for (const component of catalog) {
    assert.ok(component.scripts.resolve)
    assert.ok(component.scripts.recover)
    assert.deepEqual(component.actions, ['install', 'upgrade', 'replace'])
  }
})
