import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionIdError, sessionMatches } from '../src/query.ts'
import { removeArchivedSession, type SessionRemoval } from '../src/remove.ts'

test('title search ignores the session id', () => {
  const row = { id: 'session-abc', title: '周报' }
  assert.equal(sessionMatches(row, 'title', '周'), true)
  assert.equal(sessionMatches(row, 'title', 'abc'), false)
  assert.equal(sessionMatches(row, 'title', '  '), true)
})

test('id search ignores the title', () => {
  const row = { id: 'session-abc', title: '周报' }
  assert.equal(sessionMatches(row, 'id', 'ABC'), true)
  assert.equal(sessionMatches(row, 'id', '周报'), false)
})

test('a session id with spaces is rejected', () => {
  assert.equal(sessionIdError('session-1'), undefined)
  assert.equal(sessionIdError(''), '会话编号不对')
  assert.equal(sessionIdError('session 1'), '会话编号不对')
})

test('delete refuses a session that is not archived', async () => {
  const result = await removeArchivedSession(removal(), 'session-1')
  assert.deepEqual(result, { ok: false, status: 400, detail: '先归档再删除' })
})

test('delete refuses a session that is still running', async () => {
  const result = await removeArchivedSession(removal({ archived: () => true, running: () => true }), 'session-1')
  assert.deepEqual(result, { ok: false, status: 409, detail: '会话还在跑' })
})

test('delete erases the log before clearing the archive flag', async () => {
  const order: string[] = []
  const result = await removeArchivedSession(removal({
    archived: () => true,
    erase: async () => { order.push('erase') },
    detach: async () => { order.push('detach') },
    unarchive: async () => { order.push('unarchive') },
  }), 'session-1')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(order, ['erase', 'detach', 'unarchive'])
})

test('a live session is released before its log is erased', async () => {
  let live = true
  const order: string[] = []
  const result = await removeArchivedSession(removal({
    archived: () => true,
    live: () => live,
    release: async () => {
      order.push('release')
      live = false
      return true
    },
    erase: async () => { order.push('erase') },
  }), 'session-1')
  assert.equal(result.ok, true)
  assert.deepEqual(order.slice(0, 2), ['release', 'erase'])
})

function removal(overrides: Partial<SessionRemoval> = {}): SessionRemoval {
  return {
    archived: () => false,
    running: () => false,
    live: () => false,
    release: async () => false,
    detach: async () => undefined,
    unarchive: async () => undefined,
    erase: async () => undefined,
    ...overrides,
  }
}
