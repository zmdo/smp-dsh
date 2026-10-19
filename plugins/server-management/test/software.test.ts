import assert from 'node:assert/strict'
import test from 'node:test'
import { detectSoftware, inspectContainers, installRequired, parseSoftwareProbe } from '../src/software.ts'
import { ServerError } from '../src/i18n.ts'
import type { CommandResult, SshSession } from '../src/ssh.ts'
import { builtinCatalog, componentFixture } from './fixtures.ts'

function session(run: (command: string) => CommandResult) {
  const commands: string[] = []
  const uploads: string[] = []
  const ssh: SshSession = {
    fingerprint: 'SHA256:test',
    async exec(command) { commands.push(command); return run(command) },
    async putScript(name) { uploads.push(name) },
    async shell() { throw new Error('No terminal expected') },
    close() {},
  }
  return { ssh, commands, uploads }
}
const result = (code = 0, stdout = '', stderr = '') => ({ code, stdout, stderr })

test('structured detection distinguishes missing and unknown without interpreting a failed script as absence', () => {
  assert.equal(parseSoftwareProbe(result(0, '{"state":"missing"}')).state, 'missing')
  assert.equal(parseSoftwareProbe(result(0, '{"state":"installed","version":"1.2.3"}')).version, '1.2.3')
  assert.equal(parseSoftwareProbe(result(1, '{"state":"missing"}')).state, 'unknown')
  assert.equal(parseSoftwareProbe(result(0, 'plain output')).state, 'unknown')
  assert.equal(parseSoftwareProbe(result(0, '{"installed":false}')).state, 'unknown')
})

test('a vacant type runs no software scripts and skips container inspection when Docker is absent', async () => {
  const remote = session(() => result(1))
  assert.deepEqual(await detectSoftware(remote.ssh, []), {})
  assert.deepEqual(await installRequired(remote.ssh, [], {}), {})
  const inspected = await inspectContainers(remote.ssh)
  assert.equal(inspected.state, 'unavailable')
  assert.deepEqual(remote.commands, ['command -v docker >/dev/null 2>&1'])
  assert.deepEqual(remote.uploads, [])
})

test('Docker permission failures are unknown and block installation before any upload', async () => {
  const remote = session(command => command.startsWith('command -v') ? result() : result(1, '', 'permission denied while connecting to Docker'))
  const detected = await detectSoftware(remote.ssh, builtinCatalog())
  assert.equal(detected.docker?.state, 'unknown')
  await assert.rejects(installRequired(remote.ssh, builtinCatalog(), detected), cause => cause instanceof ServerError && cause.code === 'software_detection_unknown')
  assert.deepEqual(remote.uploads, [])
})

test('a missing Compose command is distinct from a broken Docker connection', async () => {
  const remote = session(command => command.startsWith('command -v') ? result() : command.startsWith('docker compose')
    ? result(1, '', "docker: 'compose' is not a docker command.") : result(0, '{"Server":{"Version":"27.2.0"}}'))
  const detected = await detectSoftware(remote.ssh, builtinCatalog())
  assert.equal(detected.docker?.state, 'installed')
  assert.equal(detected.compose?.state, 'missing')
})

test('custom software installs only missing requirements and verifies the result', async () => {
  let installed = false
  const remote = session(command => {
    if (command.endsWith('-install.sh')) { installed = true; return result() }
    return result(0, JSON.stringify({ state: installed ? 'installed' : 'missing' }))
  })
  const wanted = [componentFixture('custom')]
  const status = await detectSoftware(remote.ssh, wanted)
  const actual = await installRequired(remote.ssh, wanted, status)
  assert.equal(actual.custom?.state, 'installed')
  assert.equal(remote.commands.filter(command => command.endsWith('-install.sh')).length, 1)
  assert.equal(remote.uploads.length, 3)
  await installRequired(remote.ssh, wanted, actual)
  assert.equal(remote.uploads.length, 3)
})

test('a zero installer exit code is insufficient when the software is still missing', async () => {
  const remote = session(command => command.endsWith('-install.sh') ? result() : result(0, '{"state":"missing"}'))
  const wanted = [componentFixture('custom')]
  await assert.rejects(installRequired(remote.ssh, wanted, await detectSoftware(remote.ssh, wanted)), cause => cause instanceof ServerError && cause.code === 'software_install_unverified')
})

test('optional container inspection preserves unknown and failed states instead of reporting an empty machine', async () => {
  const failed = session(command => command.startsWith('command -v') ? result() : result(1, '', 'permission denied'))
  assert.equal((await inspectContainers(failed.ssh)).state, 'error')
  const remote = session(command => command.startsWith('command -v') ? result() : command.startsWith('docker version')
    ? result(0, '{"Server":{"Version":"27.2.0"}}') : command.startsWith('docker compose')
      ? result(1, '', "docker: 'compose' is not a docker command.") : result(0, '{"ID":"abc","Names":"web","Image":"nginx","State":"running"}'))
  const observed = await inspectContainers(remote.ssh)
  assert.equal(observed.state, 'ready')
  assert.equal(observed.containers?.[0]?.name, 'web')
  assert.equal(observed.compose, null)
})
