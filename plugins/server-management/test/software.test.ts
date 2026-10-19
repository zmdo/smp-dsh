import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectContainers } from '../src/software.ts'
import { parseRecipeResponse } from '../src/recipe.ts'
import { preparePlan, checkPlan } from '../src/plans.ts'
import type { TypeLease } from '../src/registry.ts'
import type { SshSession } from '../src/ssh.ts'
import { componentFixture } from './fixtures.ts'
const os = { family: 'builtin/ubuntu', version: '24.04', architecture: 'x86_64' }
const candidate = {
  version: '1.2.3',
  targetIdentity: 'package=1:1.2.3-1',
  packages: [
    { manager: 'apt', name: 'package', version: '1:1.2.3-1', architecture: 'amd64', source: 'pool/package.deb' },
  ],
  channel: 'stable',
}
function fixture() {
  let state: 'installed' | 'missing' | 'unknown' = 'missing',
    changed = false
  const requests: string[] = []
  const component = componentFixture('custom')
  const lease: TypeLease = {
    type: { key: 'test/type', name_i18n: { zh: '测试', en: 'Test' }, software: [], supportedOs: { kind: 'all' } },
    components: [component],
    signature: 'type-revision',
    release() {},
  }
  const session: SshSession = {
    fingerprint: 'test',
    close() {},
    async shell() {
      throw Error('unexpected')
    },
    async putScript() {
      throw Error('unexpected')
    },
    async exec(_command, _timeout, options) {
      const r = JSON.parse(options!.stdin!)
      requests.push(r.operation)
      let response
      switch (r.operation) {
        case 'detect':
          response = {
            operation: r.operation,
            result:
              state === 'installed'
                ? {
                    state,
                    version: '1.2.3',
                    targetIdentity: candidate.targetIdentity,
                    packages: candidate.packages,
                    healthy: true,
                  }
                : state === 'unknown'
                  ? { state, code: 'failed' }
                  : { state },
          }
          break
        case 'list-candidates':
          response = { operation: r.operation, candidates: [candidate] }
          break
        case 'resolve':
          response = {
            operation: r.operation,
            change: {
              software: r.software,
              recipe: r.recipe,
              recipeRevision: r.recipeRevision,
              action: 'install',
              before: r.installed,
              target: r.target,
              dependencies: [],
              effects: [],
              payload: { version: changed ? 'changed' : '1:1.2.3-1' },
            },
            additionalRequirements: [],
          }
          break
        default:
          throw Error('read-only planning tried mutation')
      }
      return { code: 0, stdout: JSON.stringify(response), stderr: '' }
    },
  }
  return {
    session,
    lease,
    requests,
    state(value: typeof state) {
      state = value
    },
    drift() {
      changed = true
    },
  }
}
test('preparation freezes raw package versions and rechecks the exact dependency plan without executing', async () => {
  const f = fixture()
  const plan = await preparePlan(f.session, f.lease, os)
  assert.equal(plan.changes[0]!.target!.packages[0]!.version, '1:1.2.3-1')
  await checkPlan(f.session, f.lease, plan)
  assert.equal(f.requests.includes('execute'), false)
  f.drift()
  await assert.rejects(checkPlan(f.session, f.lease, plan), { code: 'plan_conflict' })
})
test('unknown observations cannot authorize installation; already compliant software is kept', async () => {
  const f = fixture()
  f.state('unknown')
  await assert.rejects(preparePlan(f.session, f.lease, os), { code: 'software_detection_unknown' })
  f.state('installed')
  const plan = await preparePlan(f.session, f.lease, os)
  assert.equal(plan.changes[0]!.action, 'keep')
})
test('protocol boundary rejects malformed successful responses and undeclared dependencies', () => {
  for (const raw of [
    'not json',
    '{"operation":"detect","result":{"state":"installed"}}',
    '{"operation":"detect","result":{"state":"missing"}}',
  ]) {
    if (raw.includes('missing')) assert.equal(parseRecipeResponse(raw, 'detect').operation, 'detect')
    else assert.throws(() => parseRecipeResponse(raw, 'detect'))
  }
  assert.throws(() => parseRecipeResponse('{"operation":"execute","state":"completed","changes":[]}', 'detect'))
})
test('optional container inspection distinguishes absent Docker from a failed inspection', async () => {
  const f = fixture()
  f.session.exec = async () => ({ code: 1, stdout: '', stderr: '' })
  assert.equal((await inspectContainers(f.session)).state, 'unavailable')
  f.session.exec = async (command) =>
    command.startsWith('command -v')
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: 'permission denied' }
  const failed = await inspectContainers(f.session)
  assert.equal(failed.state, 'error')
  assert.match(failed.detail!, /permission denied/)
  f.session.exec = async command => {
    if (command.startsWith('command -v')) return { code: 0, stdout: '', stderr: '' }
    if (command.startsWith('docker version')) return { code: 0, stdout: '{"Server":{"Version":"29.1.3"}}', stderr: '' }
    return { code: 1, stdout: '', stderr: 'compose detection failed' }
  }
  const compose = await inspectContainers(f.session)
  assert.equal(compose.state, 'error')
  assert.match(compose.detail!, /compose detection failed/)
})
