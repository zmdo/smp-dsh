import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CatalogError, loadCatalog, normalizeSelection } from '../src/catalog.ts'

test('a catalog keeps order and refuses a missing requirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'components-'))
  await mkdir(join(root, 'compose'))
  await mkdir(join(root, 'docker'))
  await writeFile(join(root, 'docker', 'component.json'), JSON.stringify({ id: 'docker', name: 'Docker', order: 10, requires: [] }))
  await writeFile(join(root, 'compose', 'component.json'), JSON.stringify({ id: 'compose', name: 'Compose', order: 20, requires: ['docker'] }))
  const catalog = await loadCatalog(root)
  assert.deepEqual(catalog.map(item => item.id), ['docker', 'compose'])
  assert.deepEqual(normalizeSelection(catalog, ['compose', 'docker']), ['docker', 'compose'])
  assert.throws(() => normalizeSelection(catalog, ['compose']), CatalogError)
})

test('a missing component directory fails', async () => {
  await assert.rejects(loadCatalog(join(tmpdir(), 'missing-components-dir')), CatalogError)
})
