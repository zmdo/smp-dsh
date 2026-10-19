import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { builtinCatalog, componentRevision } from '../src/catalog.ts'
import { DefinitionRegistry } from '../src/registry.ts'
import { GENERAL_TYPE, VACANT_TYPE } from '../src/definitions.ts'
import { parseDeclaredOs } from '../src/operating-systems.ts'
import { parseServerListQuery, serverList, serverRead } from '../src/server-list.ts'
import type { Db } from '../src/store.ts'

test('server pages aggregate all matching states before pagination and keep counts and observations consistent',
  { skip: !process.env.SMP_TEST_DATABASE_URL, timeout: 60_000 }, async t => {
    const schema = `server_list_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: process.env.SMP_TEST_DATABASE_URL })
    await admin.query(`create schema ${schema}`)
    const db = new Pool({ connectionString: process.env.SMP_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
    t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
    for (const file of ['0010_server_management.sql', '0012_server_types.sql', '0013_server_observations.sql', '0014_server_execution.sql'])
      await db.query(await readFile(new URL(`../../database/migrations/${file}`, import.meta.url), 'utf8'))
    const catalog = builtinCatalog(), definitions = new DefinitionRegistry(db, catalog)
    t.after(() => definitions.close())
    const deps = { db, definitions }, group = randomUUID(), ids: string[] = []
    await db.query("insert into server_groups(id,name) values($1,'group one')", [group])
    const os = parseDeclaredOs({ kind: 'catalog', family: 'builtin/ubuntu', releaseKey: '24.04' })
    const vacant = definitions.defaultOptions().types.find(type => type.key === VACANT_TYPE)!
    const general = definitions.defaultOptions().types.find(type => type.key === GENERAL_TYPE)!
    for (let n = 0; n < 25; n++) {
      const id = randomUUID(); ids.push(id)
      await db.query(`insert into servers(id,name,host,ssh_user,auth_method,secret_ciphertext,type_key,type_snapshot,type_revision,declared_os,group_id,region)
        values($1,'node',$2,'test','password','secret',$3,$4,'test',$5,$6,'Singapore')`,
        [id, `192.0.2.${n + 1}`, VACANT_TYPE, JSON.stringify(vacant), JSON.stringify(os), n < 17 ? group : null])
      await db.query(`insert into server_runtime(server_id,connection_state,connection_checked_at,os_probe_state,detected_os,os_checked_at,os_last_success_at,observed_config_revision)
        values($1,$2,now()-make_interval(secs=>$3),'detected',$4,now(),now(),1)`,
        [id, n < 15 ? 'online' : n < 20 ? 'offline' : 'unknown', n, JSON.stringify({ family: 'builtin/ubuntu', version: '24.04', architecture: 'x86_64' })])
    }
    const page = (extra: Record<string, string> = {}) => serverList(deps, parseServerListQuery(new URLSearchParams(extra)))
    const first = await page(), second = await page({ page: '2' }), last = await page({ page: '999' })
    assert.equal(first.total, 25)
    assert.equal(first.items.length, 10)
    assert.equal(last.page, 3)
    assert.equal(last.items.length, 5)
    assert.deepEqual([...first.items, ...second.items, ...last.items].map(item => item.id), [...ids].sort())
    assert.deepEqual(first.counts, { all: 25, ungrouped: 8 })
    assert.equal(first.groups[0]!.server_count, 17)
    assert.equal('definition' in first.groups[0]!, false)
    for (const item of first.items) {
      assert.equal(item.installRequiredSoftware.applicability, 'not-applicable')
      assert.equal(item.resources.cpuPercent, null)
      assert.equal(item.resources.sampledAt, null)
      assert.equal('required_software' in item, false)
      assert.equal('docker_version' in item, false)
    }
    assert.equal((await page({ status: 'normal' })).total, 15)
    assert.equal((await page({ status: 'disconnected' })).total, 5)
    assert.equal((await page({ status: 'unverified' })).total, 5)
    assert.equal((await page({ group_id: group, status: 'normal', page: '2' })).items.length, 5)
    assert.equal((await page({ group_id: 'ungrouped', status: 'disconnected' })).total, 3)
    assert.equal((await page({ group_id: 'ungrouped' })).counts.all, 25)
    const deleted = await page({ group_id: randomUUID() })
    assert.equal(deleted.group_id, null)
    assert.equal(deleted.total, 25)
    for (const q of ['Ubuntu 24.04', '空置服务器', 'Vacant server', 'Singapore']) assert.equal((await page({ q })).total, 25)
    assert.equal((await page({ q: '192.0.2.25' })).total, 1)
    assert.equal((await page({ q: "' OR true--" })).total, 0)
    assert.equal((await page({ q: '%' })).total, 0)
    const empty = await page({ q: 'missing', page: '999' })
    assert.equal(empty.page, 1)
    assert.deepEqual(empty.items, [])
    assert.equal((await page({ order: 'last_checked' })).items[0]!.id, ids[0])
    // Required software is evaluated by current recipe, revision, health and version policy.
    const server = ids[0]!
    await db.query('update servers set type_key=$2,type_snapshot=$3,install_required_software=true where id=$1', [server, GENERAL_TYPE, JSON.stringify(general)])
    assert.equal((await serverRead(deps, server))!.status.code, 'unverified')
    for (const component of catalog) await db.query(`insert into server_software_observations(server_id,software_key,probe_state,checked_at,
      observed_config_revision,observed_environment_revision,recipe_key,recipe_revision,last_known_state,product_version,target_identity,healthy,last_success_at)
      values($1,$2,'installed',now(),1,0,$3,$4,'installed','29.1.3','exact-package',true,now())`,
      [server, component.software_key, component.recipe, componentRevision(component)])
    const installed = await serverRead(deps, server)
    assert.equal(installed!.status.code, 'normal')
    assert.equal(installed!.installation.enabled, true)
    assert.equal(installed!.installation.applicability, 'applicable')
    await db.query('update servers set install_required_software=false where id=$1', [server])
    assert.equal((await serverRead(deps, server))!.status.code, 'normal')
    let changed = false
    const snapshotDb: Db = {
      query: db.query.bind(db),
      async connect() {
        const client = await db.connect()
        return {
          async connect() { throw Error('Unexpected nested read transaction') },
          release: () => client.release(),
          async query(sql, params) {
            if (!changed && sql.startsWith('select * from server_software_observations')) {
              changed = true
              await db.query('update servers set config_revision=2 where id=$1', [server])
            }
            return client.query(sql, params)
          },
        }
      },
    }
    assert.equal((await serverRead({ ...deps, db: snapshotDb }, server))!.status.code, 'normal')
    assert.equal((await serverRead(deps, server))!.status.code, 'unverified')
    await db.query('update servers set config_revision=1 where id=$1', [server])
    assert.equal((await serverRead(deps, server))!.installation.enabled, false)
    await db.query("update server_software_observations set healthy=false where server_id=$1 and software_key='builtin/docker-engine'", [server])
    assert.equal((await page({ status: 'attention' })).items[0]!.id, server)
    await db.query("update server_software_observations set healthy=true,recipe_revision='old-recipe' where server_id=$1", [server])
    assert.equal((await serverRead(deps, server))!.status.code, 'unverified')
    for (const component of catalog) await db.query('update server_software_observations set recipe_revision=$2,checked_at=now()-interval \'91 seconds\' where server_id=$1 and software_key=$3', [server, componentRevision(component), component.software_key])
    assert.equal((await serverRead(deps, server))!.status.code, 'unverified')
    await db.query('update server_software_observations set checked_at=now() where server_id=$1', [server])
    await db.query("update server_runtime set metrics_error='{\"message\":\"temporary metric error\"}',cpu_percent=12,metrics_sampled_at=now()-interval '91 seconds' where server_id=$1", [server])
    assert.equal((await serverRead(deps, server))!.status.code, 'normal')
    const sampled = (await page({ q: '192.0.2.1', status: 'normal' })).items.find(item => item.id === server)!
    assert.equal(sampled.resources.fresh, false)
    assert.equal(sampled.resources.cpuPercent, 12)
    await db.query(`update server_runtime set detected_os='{"family":"builtin/debian","version":"12","architecture":"x86_64"}' where server_id=$1`, [server])
    assert.equal((await serverRead(deps, server))!.status.code, 'attention')
    await db.query(`update server_runtime set detected_os='{"family":"builtin/ubuntu","version":"24.04","architecture":"x86_64"}',connection_checked_at=now()-interval '91 seconds' where server_id=$1`, [server])
    assert.equal((await serverRead(deps, server))!.status.code, 'unverified')
    // A failed historical job is not a permanent server fault once current evidence is healthy.
    await db.query('update server_runtime set connection_checked_at=now() where server_id=$1', [server])
    const job = randomUUID()
    await db.query(`insert into server_jobs(id,server_id,server_identity,purpose,state,phase,expected_config_revision,expected_environment_revision,
      definition_revision,idempotency_key,operation_id,request_snapshot,finished_at) values($1,$2,$2,'inspect','failed','finished',1,0,'test',$1::uuid::text,$3,'{"action":"inspect"}',now())`, [job, server, randomUUID()])
    assert.equal((await serverRead(deps, server))!.status.code, 'normal')
    // Provider removal keeps translated cached names and the installation choice without authorizing execution.
    const constrained = new DefinitionRegistry(db, catalog.map(item => ({ ...item, versions: { kind: 'exact' as const, version: '1.2.3' } })))
    t.after(() => constrained.close())
    const mismatch = await serverRead({ ...deps, definitions: constrained }, server)
    assert.equal(mismatch!.status.code, 'attention')
    assert.ok(mismatch!.status.reasons.some(reason => reason.code === 'software_version'))
    const registration = definitions.registerDefinitions({ contractVersion: 2, owner: '@test/list',
      types: [{ key: 'worker', name: { zh: '计算节点', en: 'Compute worker' }, supportedOs: { kind: 'all' }, requirements: [] }],
      groups: [{ key: 'nodes', name: { zh: '计算组', en: 'Compute group' }, types: ['@test/list/worker'] }] })
    await registration.ready
    const system = (await db.query("select id from server_groups where plugin_id='@test/list'")).rows[0].id
    const worker = (await definitions.options(system)).types[0]!
    await db.query('update servers set group_id=$2,type_key=$3,type_snapshot=$4,install_required_software=true where id=$1', [server, system, worker.key, JSON.stringify(worker)])
    assert.equal((await page({ q: 'Compute worker' })).total, 1)
    assert.equal((await page({ q: '计算节点' })).total, 1)
    await registration.dispose()
    const unavailable = (await page({ q: 'Compute worker' })).items[0]!
    assert.equal(unavailable.status.code, 'attention')
    assert.equal(unavailable.installRequiredSoftware.applicability, 'unavailable')
    assert.equal(unavailable.installRequiredSoftware.enabled, true)
    assert.equal(unavailable.type.name.zh, '计算节点')
  })
