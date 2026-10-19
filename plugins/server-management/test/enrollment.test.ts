import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { SecretsCodec } from '../../database/src/fernet.ts'
import { Enrollment } from '../src/enrollment.ts'
import { DefinitionRegistry } from '../src/registry.ts'
import { builtinCatalog } from '../src/catalog.ts'
import { GENERAL_TYPE, VACANT_TYPE } from '../src/definitions.ts'
import { declaredOsFromDetected } from '../src/operating-systems.ts'
import { LINUX_PROBE, WINDOWS_PROBE } from '../src/os-probe.ts'
import type { Db } from '../src/store.ts'
import type { connectSsh, SshSession } from '../src/ssh.ts'

const credentials = {
  host: '192.0.2.1',
  ssh_port: 22,
  ssh_user: 'operator',
  auth_method: 'password',
  secret: 'test-password',
}
function setup(t: test.TestContext) {
  const secrets = new SecretsCodec(randomBytes(32))
  let stored: object | undefined, key: string | undefined
  const db: Db = {
    async query<T>(sql: string) {
      if (sql.startsWith('select secret_ciphertext from ssh_keys'))
        return { rows: (key ? [{ secret_ciphertext: secrets.encrypt(key) }] : []) as T[] }
      if (sql.startsWith('select s.id, s.host')) return { rows: (stored ? [stored] : []) as T[] }
      throw Error('Unexpected database access: ' + sql)
    },
    async connect() {
      throw Error('Enrollment must not write data')
    },
  }
  const definitions = new DefinitionRegistry(db, builtinCatalog())
  const calls: Parameters<typeof connectSsh>[0][] = [],
    operations: string[] = []
  let closed = 0,
    mode = 'linux',
    detectionFails = false
  const connect = async (input: Parameters<typeof connectSsh>[0]): Promise<SshSession> => {
    calls.push(input)
    return {
      fingerprint: 'SHA256:test-host',
      close() {
        closed++
      },
      async shell() {
        throw Error('Unexpected shell')
      },
      async putScript() {
        throw Error('Unexpected upload')
      },
      async exec(command, _timeout, options) {
        if (command === LINUX_PROBE)
          return mode === 'windows'
            ? { code: 1, stdout: '', stderr: 'not Linux' }
            : {
                code: 0,
                stdout: `ID=${mode === 'other' ? 'opensuse-leap' : 'ubuntu'}\nVERSION_ID=${mode === 'other' ? '15.6' : '24.04'}\nSMP_ARCH=x86_64`,
                stderr: '',
              }
        if (command === WINDOWS_PROBE)
          return {
            code: 0,
            stdout: JSON.stringify({ caption: 'Microsoft Windows Server 2025 Standard', architecture: '64-bit' }),
            stderr: '',
          }
        const request = JSON.parse(options!.stdin!)
        operations.push(request.operation)
        assert.equal(request.operation, 'detect')
        if (detectionFails && request.software === 'builtin/docker-compose') throw Error('permission denied')
        const result =
          request.software === 'builtin/docker-engine'
            ? {
                state: 'installed',
                version: '27.3.1',
                targetIdentity: 'docker-ce=5:27.3.1-1',
                healthy: true,
                packages: [],
              }
            : { state: 'missing' }
        return { code: 0, stdout: JSON.stringify({ operation: 'detect', result }), stderr: '' }
      },
    }
  }
  const service = new Enrollment({ db, definitions, secrets }, connect)
  t.after(async () => {
    await service.close()
    await definitions.close()
  })
  return {
    service,
    db,
    definitions,
    secrets,
    calls,
    operations,
    get closed() {
      return closed
    },
    setMode(value: string) {
      mode = value
    },
    failDetection() {
      detectionFails = true
    },
    setKey(value: string | undefined) {
      key = value
    },
    setStored(value: object) {
      stored = value
    },
  }
}

test('connection checks resolve selected keys without exposing them or executing commands', async (t) => {
  const fixture = setup(t),
    keyId = randomUUID()
  fixture.setKey('stored-test-key')
  const result = await fixture.service.test({
    ...credentials,
    auth_method: 'private_key',
    ssh_key_id: keyId,
    secret: 'ignored-draft',
  })
  assert.equal(fixture.calls[0]!.secret, 'stored-test-key')
  assert.deepEqual(fixture.operations, [])
  assert.equal(fixture.closed, 1)
  assert.equal(JSON.stringify(result).includes('stored-test-key'), false)
  assert.equal(fixture.secrets.decrypt(result.connection_token).includes('stored-test-key'), false)
})

test('identification requires a current connection receipt and pins the tested host', async (t) => {
  const fixture = setup(t)
  await assert.rejects(fixture.service.identify(credentials), { code: 'connection_test_required' })
  const result = await fixture.service.test(credentials),
    body = { ...credentials, connection_token: result.connection_token, type_key: GENERAL_TYPE }
  for (const changes of [
    { host: '192.0.2.2' },
    { ssh_port: 2222 },
    { secret: 'changed' },
    { connection_token: 'forged' },
  ])
    await assert.rejects(fixture.service.identify({ ...body, ...changes }), { code: 'connection_test_required' })
  const expired = JSON.parse(fixture.secrets.decrypt(result.connection_token))
  expired.expiresAt = 0
  await assert.rejects(
    fixture.service.identify({ ...body, connection_token: fixture.secrets.encrypt(JSON.stringify(expired)) }),
    { code: 'connection_test_required' },
  )
  assert.equal(fixture.calls.length, 1)
  const identified = await fixture.service.identify(body)
  assert.equal(fixture.calls[1]!.expectedFingerprint, result.fingerprint)
  assert.equal(identified.declared_os.kind, 'catalog')
  assert.equal(identified.detected_os.family, 'builtin/ubuntu')
  assert.equal(identified.software_status.docker?.state, 'installed')
  assert.equal(identified.software_status.docker?.version, '27.3.1')
  assert.equal(identified.software_status.compose?.state, 'missing')
  assert.deepEqual(fixture.operations, ['detect', 'detect'])
  assert.equal(fixture.closed, 2)
})

test('a selected key changing after connection testing invalidates identification', async (t) => {
  const fixture = setup(t),
    input = { ...credentials, auth_method: 'private_key', ssh_key_id: randomUUID() }
  fixture.setKey('first-key')
  const tested = await fixture.service.test(input)
  fixture.setKey('replacement-key')
  await assert.rejects(fixture.service.identify({ ...input, connection_token: tested.connection_token }), {
    code: 'connection_test_required',
  })
  assert.equal(fixture.calls.length, 1)
})

test('partial software detection failures retain OS and other actual versions', async (t) => {
  const fixture = setup(t)
  fixture.failDetection()
  const tested = await fixture.service.test(credentials)
  const result = await fixture.service.identify({
    ...credentials,
    connection_token: tested.connection_token,
    type_key: GENERAL_TYPE,
  })
  assert.equal(result.detected_os.version, '24.04')
  assert.equal(result.software_status.docker?.version, '27.3.1')
  assert.equal(result.software_status.compose?.state, 'unknown')
  assert.notEqual(result.software_status.compose?.state, 'missing')
})

test('Windows and unknown distributions fall back to safe vacant types without Linux software recipes', async (t) => {
  const fixture = setup(t)
  for (const mode of ['windows', 'other']) {
    fixture.setMode(mode)
    const tested = await fixture.service.test(credentials)
    const result = await fixture.service.identify({
      ...credentials,
      connection_token: tested.connection_token,
      type_key: GENERAL_TYPE,
    })
    assert.equal(result.type_key, VACANT_TYPE)
    assert.equal(result.declared_os.kind, mode === 'windows' ? 'catalog' : 'custom')
    assert.deepEqual(result.required_software, [])
  }
  assert.deepEqual(fixture.operations, [])
  assert.equal(
    declaredOsFromDetected({ family: 'builtin/debian', version: '12.10', architecture: 'x86_64' }).kind,
    'catalog',
  )
  assert.equal(
    declaredOsFromDetected({ family: 'builtin/ubuntu', version: '24.10', architecture: 'x86_64' }).kind,
    'custom',
  )
})

test('saved passwords are reusable only for the unchanged server and preserve its pinned host', async (t) => {
  const fixture = setup(t),
    serverId = randomUUID()
  fixture.setStored({
    id: serverId,
    host: credentials.host,
    ssh_port: 22,
    ssh_user: credentials.ssh_user,
    auth_method: 'password',
    secret_ciphertext: fixture.secrets.encrypt('saved-password'),
    host_fingerprint: 'SHA256:saved',
    config_revision: 3,
  })
  await fixture.service.test({ ...credentials, secret: '', server_id: serverId })
  assert.equal(fixture.calls[0]!.secret, 'saved-password')
  assert.equal(fixture.calls[0]!.expectedFingerprint, 'SHA256:saved')
  await assert.rejects(fixture.service.test({ ...credentials, secret: '', server_id: serverId, host: '192.0.2.2' }), {
    code: 'password_required',
  })
})

test('unloading waits for late SSH connections and closes them before any identification', async (t) => {
  const fixture = setup(t)
  let accept!: (session: SshSession) => void,
    closed = false
  const service = new Enrollment(
    { db: fixture.db, definitions: fixture.definitions, secrets: fixture.secrets },
    () =>
      new Promise((resolve) => {
        accept = resolve
      }),
  )
  const operation = service.test(credentials)
  await new Promise((resolve) => setImmediate(resolve))
  const stopped = service.close()
  accept({
    fingerprint: 'SHA256:test',
    close() {
      closed = true
    },
    async exec() {
      throw Error('Must not execute')
    },
    async shell() {
      throw Error('Must not open')
    },
    async putScript() {
      throw Error('Must not upload')
    },
  })
  await assert.rejects(operation, { code: 'definitions_unavailable' })
  await stopped
  assert.equal(closed, true)
  await assert.rejects(service.test(credentials), { code: 'definitions_unavailable' })
})
