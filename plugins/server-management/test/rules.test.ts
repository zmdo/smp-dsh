import assert from 'node:assert/strict'
import test from 'node:test'
import { claimCandidate, failRunning, keyInUse, openJob, shouldRetest, type JobRow } from '../src/jobs.ts'
import { omitSecrets } from '../src/records.ts'
import { parsePs, parseSample } from '../src/parse.ts'
import { chosenRegion, privatePlace } from '../src/region.ts'

const rows: JobRow[] = [
  { id: 'a', serverId: 's1', action: 'inspect', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b', serverId: 's1', action: 'inspect', status: 'running', createdAt: '2026-01-01T00:00:01.000Z' },
  { id: 'c', serverId: 's2', action: 'test_connection', status: 'queued', createdAt: '2026-01-01T00:00:02.000Z' },
]

test('an open job is reused and a busy server is not claimed', () => {
  assert.equal(openJob(rows, 's1', 'inspect')?.id, 'a')
  assert.equal(claimCandidate(rows)?.id, 'c')
  assert.equal(failRunning(rows).find(row => row.id === 'b')?.status, 'failed')
  assert.equal(failRunning(rows).find(row => row.id === 'c')?.status, 'queued')
})

test('a metric sample clamps cpu and disk', () => {
  const sample = parseSample('2 100 80 200 100 1024 512 1000 1200')
  assert.equal(sample.cpuCores, 2)
  assert.equal(sample.cpuPercent, 80)
  assert.equal(sample.memTotalBytes, 1024 * 1024)
  assert.equal(sample.diskUsedBytes, 1000)
})

test('container lines become records', () => {
  const rows = parsePs('{"ID":"abc","Names":"/web","Image":"nginx","State":"running","Ports":"80/tcp","Labels":"smp.managed=true,smp.strategy=alpha"}\n')
  assert.equal(rows[0]?.name, 'web')
  assert.equal(rows[0]?.managed, true)
  assert.equal(rows[0]?.strategySlug, 'alpha')
})

test('a written region wins and a private address is local', () => {
  assert.equal(chosenRegion('10.0.0.1', '机房', '内网'), '机房')
  assert.equal(privatePlace('10.1.2.3'), '内网')
  assert.equal(privatePlace('8.8.8.8'), undefined)
  assert.throws(() => chosenRegion('10.0.0.1', 'x'.repeat(81), null))
})

test('a busy key and a quiet connection change stay put', () => {
  assert.equal(keyInUse(2), true)
  assert.equal(keyInUse(0), false)
  assert.equal(shouldRetest({ autoInstall: false, connectionChanged: true, selectionChanged: false }), false)
  assert.equal(shouldRetest({ autoInstall: true, connectionChanged: false, selectionChanged: true }), true)
})

test('a server response drops the stored secret', () => {
  const visible = omitSecrets({ id: 's', name: 'web', secret_ciphertext: 'cipher', secret: 'plain' })
  assert.equal('secret_ciphertext' in visible, false)
  assert.equal('secret' in visible, false)
  assert.equal(visible.name, 'web')
})
