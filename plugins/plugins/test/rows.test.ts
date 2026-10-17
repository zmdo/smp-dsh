import assert from 'node:assert/strict'
import test from 'node:test'
import { globalRows, moduleShortName } from '../src/rows.ts'

test('a package name loses its scope and harness prefix', () => {
  assert.equal(moduleShortName('@deepseek-ai/dsh-host-plugin-inventory'), 'plugin-inventory')
  assert.equal(moduleShortName('cordis-plugin-timer'), 'timer')
})

test('the global list keeps loader order and leaves preset compositions out', () => {
  const entries = [
    { entryId: 'inventory', moduleName: '@deepseek-ai/dsh-host-plugin-inventory', enabled: true, fiberPhase: 'active' as const, meta: { title: { zh: '插件清单', en: 'Inventory' }, description: { zh: '只读', en: 'Read only' } } },
    { entryId: 'timer', moduleName: 'cordis-plugin-timer', enabled: false, fiberPhase: null, meta: { title: 'cordis-plugin-timer' } },
    { entryId: 'broken', moduleName: 'dsh-client-ui-chat', enabled: true, fiberPhase: 'failed' as const },
  ]
  const presets = [{ id: 'default', name: '默认', rows: [{ moduleName: 'cordis-plugin-timer', enabled: true as const }] }]
  const rows = globalRows(entries, presets, 'zh', '')
  assert.deepEqual(rows.map(row => row.title), ['插件清单', 'timer', 'ui-chat'])
  assert.equal(rows[0]?.description, '只读')
  assert.equal(rows[0]?.status, 'enabled')
  assert.equal(rows[1]?.status, 'preset')
  assert.deepEqual(rows[1]?.enabledIn, ['默认'])
  assert.equal(rows[2]?.status, 'failed')
  assert.deepEqual(globalRows(entries, presets, 'en', 'inventory').map(row => row.id), ['inventory'])
  assert.deepEqual(globalRows(entries, presets, 'zh', '不存在'), [])
})
