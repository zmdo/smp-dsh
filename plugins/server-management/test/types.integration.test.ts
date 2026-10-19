import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { GENERAL_TYPE, VACANT_TYPE, type SystemGroupDefinition } from '../src/definitions.ts'
import { errorPayload, ServerError } from '../src/i18n.ts'
import { routeGroups, routeServers, routeTypes } from '../src/records.ts'
import { DefinitionRegistry, requiredSoftware } from '../src/registry.ts'
import { executeJob } from '../src/runner.ts'
import { ServerManagement } from '../src/service.ts'
import { claimNext, enqueue, HttpError, type Db } from '../src/store.ts'
import type { SshSession } from '../src/ssh.ts'
import { builtinCatalog, componentFixture } from './fixtures.ts'

// Uses a disposable schema only. The configured database's application tables are never touched.
test('server types, system groups, lifecycle and jobs against PostgreSQL', { skip: !process.env.SMP_TEST_DATABASE_URL, timeout: 30_000 }, async t => {
  const admin = new Pool({ connectionString: process.env.SMP_TEST_DATABASE_URL })
  const schema = `server_types_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema ${schema}`)
  const pool = new Pool({ connectionString: process.env.SMP_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const db = pool as unknown as Db
  const directory = await mkdtemp(join(tmpdir(), 'smp-server-types-'))
  t.after(async () => { await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); await rm(directory, { recursive: true, force: true }) })
  await pool.query(await readFile(new URL('../../database/migrations/0010_server_management.sql', import.meta.url), 'utf8'))
  const oldId = randomUUID()
  await pool.query("insert into servers (id,name,intranet_host,ssh_user,auth_method,secret_ciphertext,reachability) values ($1,'old','10.0.0.1','root','password','test','docker_unavailable')", [oldId])
  await pool.query(await readFile(new URL('../../database/migrations/0012_server_types.sql', import.meta.url), 'utf8'))
  const catalog = builtinCatalog()
  for (const item of catalog) item.installScript = Buffer.from(`install-${item.id}`)
  const definitions = new DefinitionRegistry(db, catalog)
  t.after(() => definitions.close())
  const secrets = { encrypt: (value: string) => value, decrypt: (value: string) => value }
  const deps = { db, definitions, secrets, catalog }
  const http = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, 'http://localhost').pathname
      if (path.startsWith('/servers')) await routeServers(deps, req, res, path.slice('/servers'.length))
      else if (path.startsWith('/groups')) await routeGroups(db, req, res, path.slice('/groups'.length), definitions)
      else await routeTypes(definitions, req, res)
    } catch (cause) {
      res.writeHead(cause instanceof HttpError ? cause.status : cause instanceof ServerError ? 422 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify(cause instanceof ServerError ? errorPayload(cause) : { error: String(cause) }))
    }
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())))
  const port = (http.address() as { port: number }).port
  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any }
  }
  let hostIndex = 10
  const serverInput = (extra = {}) => ({ name: 'test', intranet_host: `10.0.0.${hostIndex++}`, ssh_port: 22, ssh_user: 'root', auth_method: 'password', secret: 'test-password', region: 'test', ...extra })
  const group: SystemGroupDefinition = { plugin: '@test/provider', key: 'compute', name: { zh: '计算节点', en: 'Compute nodes' } }
  const groupId = async () => (await pool.query('select id from server_groups where plugin_id = $1 and group_key = $2', [group.plugin, group.key])).rows[0].id as string
  const detectScript = join(directory, 'detect.sh')
  const installScript = join(directory, 'install.sh')
  await writeFile(detectScript, 'detect-custom')
  await writeFile(installScript, 'install-custom')
  const custom: SystemGroupDefinition = { ...group,
    software: [{ id: 'custom', name: { zh: '自定义软件', en: 'Custom software' }, detectScript, installScript }],
    types: [{ key: 'node', name: { zh: '节点', en: 'Node' }, software: ['custom'] }], defaultType: 'node',
  }

  await t.test('migration preserves existing requirements and defaults new registrations to vacant', async () => {
    const old = (await api('GET', `/servers/${oldId}`)).body
    assert.equal(old.type_key, GENERAL_TYPE)
    assert.equal(old.reachability, 'online')
    assert.deepEqual(old.required_software.map((item: any) => item.id), ['docker', 'compose'])
    const created = await api('POST', '/servers', serverInput({ auto_install: true }))
    assert.equal(created.status, 201)
    assert.equal(created.body.type_key, VACANT_TYPE)
    assert.equal(created.body.auto_install, false)
    assert.deepEqual(created.body.required_software, [])
    assert.equal(created.body.jobs.length, 0)
    assert.equal(created.body.secret_ciphertext, undefined)
    const ordinary = await api('POST', '/servers', serverInput({ type_key: GENERAL_TYPE }))
    assert.equal(ordinary.status, 201)
    assert.deepEqual(ordinary.body.install_component_ids, ['docker', 'compose'])
    assert.equal((await api('POST', '/servers', serverInput({ install_component_ids: [] }))).body.code, 'required_software_readonly')
    assert.equal((await api('POST', '/servers', serverInput({ type_key: 'forged' }))).body.code, 'type_not_found')
    assert.equal((await api('POST', '/groups', { name: 'forged', kind: 'system' })).body.code, 'group_source_readonly')
  })

  await t.test('system group identity persists, fallback types work, deletion is denied, unload drains active work', async () => {
    const unregister = await definitions.registerGroup(group)
    const id = await groupId()
    assert.deepEqual((await api('GET', `/types?group_id=${id}`)).body.types.map((item: any) => item.key), [VACANT_TYPE, GENERAL_TYPE])
    assert.equal((await api('DELETE', `/groups/${id}`)).status, 403)
    const lease = await definitions.lease(id, VACANT_TYPE)
    assert.ok(lease)
    let done = false
    const draining = unregister().then(() => { done = true })
    await Promise.resolve()
    assert.equal(done, false)
    assert.equal(await definitions.lease(id, VACANT_TYPE), undefined)
    assert.equal((await api('GET', '/groups')).body.find((row: any) => row.id === id).name_i18n.en, 'Compute nodes')
    lease.release()
    await draining
    const next = await definitions.registerGroup(group)
    assert.equal(await groupId(), id)
    await unregister() // An old disposer must not remove a later registration.
    assert.equal((await definitions.options(id)).available, true)
    await next()
  })

  await t.test('custom types replace defaults; software dependencies and provider definitions are validated', async () => {
    assert.deepEqual(requiredSoftware(catalog, ['compose']).map(item => item.id), ['docker', 'compose'])
    assert.throws(() => requiredSoftware([componentFixture('a', ['b']), componentFixture('b', ['a'])], ['a']))
    for (const bad of [{ ...custom, types: [] }, { ...custom, defaultType: 'absent' }, { ...custom, name: { zh: '中', en: '' } }, { ...custom, types: [{ ...custom.types![0]!, software: ['absent'] }] }]) {
      await assert.rejects(definitions.registerGroup(bad))
    }
    await assert.rejects(definitions.registerGroup({ ...custom, version: '1' } as SystemGroupDefinition), cause => cause instanceof ServerError && cause.code === 'definition_unsupported')
    const unregister = await definitions.registerGroup(custom)
    const id = await groupId()
    const options = (await api('GET', `/types?group_id=${id}`)).body
    assert.deepEqual(options.types.map((item: any) => item.key), ['@test/provider/node'])
    assert.deepEqual(options.types[0].software.map((item: any) => item.id), ['custom'])
    assert.equal(JSON.stringify(options).includes('detect-custom'), false)
    const server = (await api('POST', '/servers', serverInput({ group_id: id }))).body
    assert.equal(server.type_key, '@test/provider/node')
    await unregister()
    const inactive = (await api('GET', `/servers/${server.id}`)).body
    assert.equal(inactive.type_available, false)
    assert.equal(inactive.software_state, 'unavailable')
    assert.equal((await api('PATCH', `/servers/${server.id}`, { name: 'renamed' })).status, 200)
    assert.equal((await api('POST', `/servers/${server.id}/install-components`)).body.code, 'type_unavailable')
    assert.equal((await api('POST', '/servers', serverInput({ group_id: id }))).body.code, 'type_unavailable')
    const changed = await api('PATCH', `/servers/${server.id}`, { group_id: null, type_key: GENERAL_TYPE })
    assert.equal(changed.body.code, 'type_change_requires_preflight')
    assert.equal((await api('GET', `/servers/${server.id}`)).body.group_id, id)
    assert.equal((await api('PATCH', `/servers/${server.id}`, { group_id: null, type_key: VACANT_TYPE })).status, 200)
  })

  await t.test('Cordis binds registrations to their contributing plugin and cleans them on disposal', async () => {
    const root = new Context()
    const provide = root.provide('serverManagement', new ServerManagement(root, definitions))
    const owner = root.plugin({ inject: ['serverManagement'], async apply(ctx: Context) { await ctx.serverManagement.registerGroup(group) } })
    await owner
    const id = await groupId()
    assert.equal((await definitions.options(id)).available, true)
    await owner.dispose()
    assert.equal((await definitions.options(id)).available, false)
    const reloaded = root.plugin({ inject: ['serverManagement'], async apply(ctx: Context) { await ctx.serverManagement.registerGroup(group) } })
    await reloaded
    assert.equal(await groupId(), id)
    await reloaded.dispose()
    await provide()
  })

  function remote() {
    const commands: string[] = []
    const scripts = new Map<string, string>()
    const installed = new Set<string>()
    let permissionDenied = false
    const connect = async (): Promise<SshSession> => ({
      fingerprint: 'SHA256:test', close() {}, async shell() { throw new Error('unexpected terminal') },
      async putScript(name, body) { scripts.set(name, body.toString()) },
      async exec(command) {
        commands.push(command)
        const result = (code = 0, stdout = '', stderr = '') => ({ code, stdout, stderr })
        if (command.startsWith('command -v')) return result(installed.has('docker') ? 0 : 1)
        if (command.startsWith('docker version')) return permissionDenied ? result(1, '', 'permission denied') : result(0, '{"Server":{"Version":"27.2.0"}}')
        if (command.startsWith('docker compose')) return installed.has('compose') ? result(0, '{"version":"2.29.0"}') : result(1, '', "docker: 'compose' is not a docker command.")
        if (command.startsWith('docker ps')) return result(0, '{"ID":"abc","Names":"web","Image":"nginx","State":"running"}')
        const script = scripts.get(command.split('/').at(-1)!)
        if (script === 'install-custom') { installed.add('custom'); return result() }
        if (script === 'install-docker') { installed.add('docker'); return result() }
        if (script === 'install-compose') { installed.add('compose'); return result() }
        if (script === 'detect-custom') return result(0, JSON.stringify({ state: installed.has('custom') ? 'installed' : 'missing', version: '1.0.0' }))
        throw new Error(`Unexpected script: ${script}`)
      },
    })
    return { connect, commands, installed, scripts, deny() { permissionDenied = true } }
  }

  async function run(id: string, action: string, target: ReturnType<typeof remote>) {
    const queued = await api('POST', `/servers/${id}/${action}`)
    assert.equal(queued.status, 202)
    assert.equal(await claimNext(db), queued.body.id)
    await executeJob(db, secrets, definitions, queued.body.id, target.connect)
    return (await api('GET', `/servers/${id}`)).body
  }

  await t.test('vacant connections need no Docker; failed Docker inspection preserves reachability and stale containers', async () => {
    const target = remote()
    const created = (await api('POST', '/servers', serverInput())).body
    const empty = await run(created.id, 'test', target)
    assert.equal(empty.reachability, 'online')
    assert.equal(empty.containers_state, 'unavailable', empty.jobs[0].output_excerpt)
    assert.equal(empty.software_state, 'ready')
    assert.equal(empty.container_count, null)
    assert.equal(target.scripts.size, 0)
    target.installed.add('docker')
    const observed = await run(created.id, 'inspect', target)
    assert.equal(observed.containers.length, 1)
    assert.equal(observed.container_count, 1)
    target.deny()
    const failed = await run(created.id, 'inspect', target)
    assert.equal(failed.reachability, 'online')
    assert.equal(failed.containers_state, 'error')
    assert.equal(failed.container_count, null)
    assert.equal(failed.containers.length, 1)
    assert.equal(failed.containers_checked_at, observed.containers_checked_at)
  })

  await t.test('installation is limited to required custom software and verifies after reconnecting', async () => {
    const unregister = await definitions.registerGroup(custom)
    const target = remote()
    const created = (await api('POST', '/servers', serverInput({ group_id: await groupId() }))).body
    const finished = await run(created.id, 'install-components', target)
    assert.equal(finished.jobs[0].status, 'succeeded', finished.jobs[0].output_excerpt)
    assert.equal(finished.software_state, 'ready')
    assert.equal(finished.reachability, 'online')
    assert.deepEqual([...target.installed], ['custom'])
    assert.equal(target.commands.filter(command => command.endsWith('-install.sh')).length, 1)
    await unregister()
  })

  await t.test('ordinary automatic installation follows dependency order, skips installed software and refuses unknown detection', async () => {
    const target = remote()
    const created = (await api('POST', '/servers', serverInput({ type_key: GENERAL_TYPE, auto_install: true }))).body
    const jobId = created.jobs[0].id
    assert.equal(await claimNext(db), jobId)
    await executeJob(db, secrets, definitions, jobId, target.connect)
    const finished = (await api('GET', `/servers/${created.id}`)).body
    assert.equal(finished.jobs[0].status, 'succeeded', finished.jobs[0].output_excerpt)
    assert.equal(finished.software_state, 'ready')
    assert.deepEqual([...target.installed], ['docker', 'compose'])
    assert.equal(target.commands.filter(command => command.endsWith('-install.sh')).length, 2)
    await run(created.id, 'install-components', target)
    assert.equal(target.commands.filter(command => command.endsWith('-install.sh')).length, 2)
    target.deny()
    const failed = await run(created.id, 'install-components', target)
    assert.equal(failed.jobs[0].status, 'failed')
    assert.equal(failed.reachability, 'online')
    assert.equal(failed.software_state, 'unknown')
    assert.equal(target.commands.filter(command => command.endsWith('-install.sh')).length, 2)
  })

  await t.test('configuration and definition drift invalidate queued installation before running a remote installer', async () => {
    const unregister = await definitions.registerGroup(custom)
    const id = await groupId()
    const created = (await api('POST', '/servers', serverInput({ group_id: id }))).body
    const queued = await api('POST', `/servers/${created.id}/install-components`)
    await unregister()
    await writeFile(installScript, 'changed-script')
    const next = await definitions.registerGroup(custom)
    assert.equal(await claimNext(db), queued.body.id)
    const target = remote()
    await executeJob(db, secrets, definitions, queued.body.id, target.connect)
    assert.equal((await pool.query('select status from ops_jobs where id = $1', [queued.body.id])).rows[0].status, 'failed')
    assert.equal(target.commands.some(command => command.endsWith('-install.sh')), false)
    const second = await api('POST', `/servers/${created.id}/install-components`)
    assert.equal((await api('PATCH', `/servers/${created.id}`, { ssh_port: 2222 })).status, 200)
    assert.equal(await claimNext(db), second.body.id)
    const untouched = remote()
    await executeJob(db, secrets, definitions, second.body.id, untouched.connect)
    assert.equal(untouched.commands.length, 0)
    assert.equal((await pool.query('select status from ops_jobs where id = $1', [second.body.id])).rows[0].status, 'failed')
    await next()
  })

  await t.test('concurrent workers cannot claim two jobs on the same server; active work blocks critical edits', async () => {
    await enqueue(db, oldId, 'inspect')
    await enqueue(db, oldId, 'test_connection')
    const claimed = (await Promise.all([claimNext(db), claimNext(db)])).filter(Boolean)
    assert.equal(claimed.length, 1)
    assert.equal((await api('PATCH', `/servers/${oldId}`, { ssh_port: 2222 })).body.code, 'server_busy')
    assert.equal((await api('PATCH', `/servers/${oldId}`, { name: 'metadata' })).status, 200)
  })
})
