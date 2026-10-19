import assert from 'node:assert/strict'
import test from 'node:test'
import { createServerPageState } from '../src/pages/server-page-state.ts'

test('settings navigation preserves list filters and the detail destination within one plugin instance', () => {
  const state = createServerPageState(), separate = createServerPageState()
  let updates = 0
  const unsubscribe = state.subscribe(() => { updates++ })
  const view = { groupId: 'selected-group', query: 'Ubuntu', page: 3, pageSize: 20, status: 'disconnected', order: 'last_checked' as const }
  state.update({ listView: view, screen: 'detail', serverId: 'selected-server' })
  assert.equal(updates, 1)
  unsubscribe() // Page leaves for platform settings; the plugin stays loaded.
  assert.deepEqual(state.getSnapshot().listView, view)
  assert.equal(state.getSnapshot().screen, 'detail')
  assert.equal(state.getSnapshot().serverId, 'selected-server')
  const returnToPage = state.subscribe(() => { updates++ })
  state.update({ screen: 'list' })
  assert.deepEqual(state.getSnapshot().listView, view)
  assert.equal(separate.getSnapshot().listView.page, 1)
  returnToPage()
  state.dispose()
  state.update({ editing: true })
  assert.equal(updates, 2)
})
