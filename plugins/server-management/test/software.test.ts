import assert from 'node:assert/strict'
import test from 'node:test'
import {inspectContainers} from '../src/host/recipes/software.ts'
import {parseRecipeResponse} from '../src/host/recipes/protocol.ts'
import {preparePlan,checkPlan} from '../src/host/recipes/planning.ts'
import {type TypeLease} from '../src/host/definitions/model.ts'
import {type SshSession} from '../src/host/remote/ssh.ts'
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

function containerFixture(options: { sudo?: boolean; denySudo?: boolean; sudoThrows?: boolean; psFails?: boolean; composeMissing?: boolean } = {}) {
  const calls: string[] = []
  const session = fixture().session
  session.exec = async command => {
    calls.push(command)
    if (command === 'command -v docker >/dev/null 2>&1') return { code: 0, stdout: '', stderr: '' }
    if (command.startsWith('sudo -n ')) {
      if (options.sudoThrows) throw Error('sudo read timed out')
      if (options.denySudo) return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
    }
    if (options.sudo && command.startsWith('docker version'))
      return { code: 1, stdout: '', stderr: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock' }
    const plain = command.replace(/^sudo -n /, '')
    if (plain.startsWith('docker version')) return { code: 0, stdout: '{"Server":{"Version":"29.1.3"}}', stderr: '' }
    if (plain.startsWith('docker compose version')) return options.composeMissing
      ? { code: 1, stdout: '', stderr: "docker: 'compose' is not a docker command." }
      : { code: 0, stdout: '{"version":"2.40.3"}', stderr: '' }
    if (plain.startsWith('docker ps -a')) return options.psFails
      ? { code: 1, stdout: '', stderr: 'container list permission denied' }
      : { code: 0, stdout: '{"ID":"abc","Names":"web","Image":"nginx","State":"running","Ports":"80/tcp"}\n', stderr: '' }
    throw Error(`Unexpected command: ${command}`)
  }
  return { session, calls }
}

test('container inspection uses ordinary read access when available and supports absent optional Compose', async () => {
  const f = containerFixture(), result = await inspectContainers(f.session)
  assert.equal(result.state, 'ready')
  assert.equal(result.docker, '29.1.3')
  assert.equal(result.compose, '2.40.3')
  assert.equal(result.containers?.[0]?.name, 'web')
  assert.equal(f.calls.some(command => command.startsWith('sudo ')), false)
  const missing = containerFixture({ composeMissing: true })
  const withoutCompose = await inspectContainers(missing.session)
  assert.equal(withoutCompose.state, 'ready')
  assert.equal(withoutCompose.compose, null)
  assert.equal(withoutCompose.containers?.length, 1)
})

test('existing non-interactive sudo access is reused for every subsequent Docker read', async () => {
  const f = containerFixture({ sudo: true }), result = await inspectContainers(f.session)
  assert.equal(result.state, 'ready')
  assert.equal(result.containers?.length, 1)
  assert.deepEqual(f.calls, [
    'command -v docker >/dev/null 2>&1',
    "docker version --format '{{json .}}'",
    "sudo -n docker version --format '{{json .}}'",
    'sudo -n docker compose version --format json',
    "sudo -n docker ps -a --no-trunc --format '{{json .}}'",
  ])
})

test('failed sudo preserves the ordinary permission error and reports the sudo failure without prompting', async () => {
  for (const failure of [{ denySudo: true }, { sudoThrows: true }]) {
    const f = containerFixture({ sudo: true, ...failure }), result = await inspectContainers(f.session)
    assert.equal(result.state, 'error')
    assert.match(result.detail!, /permission denied.*docker API/)
    assert.match(result.detail!, failure.denySudo ? /password is required/ : /sudo read timed out/)
    assert.equal(f.calls.length, 3)
  }
})

test('an ordinary Docker context is not replaced with a different sudo context after a later read fails', async () => {
  const f = containerFixture({ psFails: true }), result = await inspectContainers(f.session)
  assert.equal(result.state, 'error')
  assert.match(result.detail!, /container list permission denied/)
  assert.equal(f.calls.some(command => command.startsWith('sudo ')), false)
})
