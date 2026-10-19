import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { GENERAL_TYPE, VACANT_TYPE } from '../src/definitions.ts'
import type { DefinitionBundle } from '../src/contracts.ts'
import { errorPayload, ServerError } from '../src/i18n.ts'
import { routeGroups, routeServers, routeTypes } from '../src/records.ts'
import { DefinitionRegistry } from '../src/registry.ts'
import { Enrollment } from '../src/enrollment.ts'
import { executeJob } from '../src/runner.ts'
import { ServerManagement } from '../src/service.ts'
import { HttpError, type Db } from '../src/store.ts'
import { claimNext, enqueue, finishJob, phase, type JobRecord } from '../src/job-store.ts'
import type { SshSession } from '../src/ssh.ts'
import { APT_SOFTWARE_OS } from '../src/operating-systems.ts'
import { LINUX_PROBE, WINDOWS_PROBE } from '../src/os-probe.ts'
import { builtinCatalog } from '../src/catalog.ts'

test(
  'atomic definitions, configuration, plans and fenced jobs against PostgreSQL',
  { skip: !process.env.SMP_TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const admin = new Pool({
        connectionString: process.env.SMP_TEST_DATABASE_URL,
      }),
      schema = `execution_${randomUUID().replaceAll('-', '')}`
    await admin.query(`create schema ${schema}`)
    const pool = new Pool({
        connectionString: process.env.SMP_TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      }),
      db = pool as unknown as Db
    const directory = await mkdtemp(join(tmpdir(), 'smp-definitions-'))
    t.after(async () => {
      await pool.end()
      await admin.query(`drop schema ${schema} cascade`)
      await admin.end()
      await rm(directory, { recursive: true, force: true })
    })
    for (const name of [
      '0010_server_management.sql',
      '0012_server_types.sql',
      '0013_server_observations.sql',
      '0014_server_execution.sql',
      '0015_server_inspection_reports.sql',
    ])
      await pool.query(await readFile(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8'))
    const catalog = builtinCatalog(),
      definitions = new DefinitionRegistry(db, catalog),
      secrets = { encrypt: (v: string) => v, decrypt: (v: string) => v },
      enrollment = new Enrollment({ db, definitions, secrets }),
      deps = { db, definitions, secrets, catalog, enrollment }
    t.after(async () => {
      await enrollment.close()
      await definitions.close()
    })
    const http = createServer(async (req, res) => {
      try {
        const path = new URL(req.url!, 'http://localhost').pathname
        if (path.startsWith('/servers')) await routeServers(deps, req, res, path.slice(8))
        else if (path.startsWith('/groups')) await routeGroups(db, req, res, path.slice(7), definitions)
        else await routeTypes(definitions, req, res)
      } catch (cause) {
        res.writeHead(cause instanceof HttpError ? cause.status : cause instanceof ServerError ? 422 : 500, {
          'content-type': 'application/json',
        })
        res.end(JSON.stringify(cause instanceof ServerError ? errorPayload(cause) : { error: String(cause) }))
      }
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise<void>((resolve) => http.close(() => resolve())))
    const port = (http.address() as { port: number }).port
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
            }),
      })
      return {
        status: response.status,
        body: response.status === 204 ? null : ((await response.json()) as any),
      }
    }
    let host = 0
    const input = (extra = {}) => ({
      name: 'node',
      host: `192.0.2.${++host}`,
      ssh_port: 22,
      ssh_user: 'root',
      auth_method: 'password',
      secret: 'secret-test',
      region: 'test',
      declared_os: {
        kind: 'catalog',
        family: 'builtin/ubuntu',
        releaseKey: '24.04',
      },
      ...extra,
    })
    const script = join(directory, 'recipe.sh')
    await writeFile(script, 'protocol fixture')
    const definition = {
      path: script,
      interpreter: 'posix-sh' as const,
      timeoutMs: 1000,
      outputLimitBytes: 4096,
    }
    const bundle: DefinitionBundle = {
      contractVersion: 2,
      owner: '@test/provider',
      software: [
        {
          key: 'tool',
          name: { zh: '工具', en: 'Tool' },
          versions: 'semver-stable',
        },
      ],
      recipes: [
        {
          key: 'tool-apt',
          software: '@test/provider/tool',
          supportedOs: APT_SOFTWARE_OS,
          detect: definition,
          listCandidates: definition,
          resolve: definition,
          mutation: {
            actions: ['install'],
            execute: definition,
            verify: definition,
            recover: definition,
          },
        },
      ],
      types: [
        {
          key: 'node',
          name: { zh: '节点', en: 'Node' },
          supportedOs: { kind: 'explicit', selectors: APT_SOFTWARE_OS },
          requirements: [
            {
              software: '@test/provider/tool',
              versions: { kind: 'series', prefix: '1' },
              recipes: ['@test/provider/tool-apt'],
            },
          ],
        },
      ],
      groups: [
        {
          key: 'nodes',
          name: { zh: '节点组', en: 'Nodes' },
          types: ['@test/provider/node'],
          defaultType: '@test/provider/node',
        },
      ],
    }
    const groupId = async (owner = '@test/provider') =>
      (await pool.query('select id from server_groups where plugin_id=$1', [owner])).rows[0].id as string
    function remote() {
      const installed = new Map<string, any>(),
        operations = new Map<string, any>(),
        requests: string[] = []
      let unknown = false,
        fail = false,
        os = 'ID=ubuntu\nVERSION_ID=24.04\nSMP_ARCH=x86_64\n'
      const target = (key: string) => ({
        version: '1.2.3',
        targetIdentity: key + '=1:1.2.3-1',
        packages: [
          {
            manager: 'apt',
            name: key,
            version: '1:1.2.3-1',
            architecture: 'amd64',
            source: 'test',
          },
        ],
        channel: 'stable',
      })
      const connect = async (): Promise<SshSession> => ({
        fingerprint: 'SHA256:test',
        close() {},
        async shell() {
          throw Error('unexpected shell')
        },
        async putScript() {
          throw Error('unexpected upload')
        },
        async exec(command, _timeout, options) {
          const ok = (value: string | object) => ({
            code: 0,
            stdout: typeof value === 'string' ? value : JSON.stringify(value),
            stderr: '',
          })
          if (command === LINUX_PROBE) return ok(os)
          if (command === WINDOWS_PROBE)
            return ok({
              caption: 'Microsoft Windows Server 2025 Standard',
              architecture: '64-bit',
            })
          if (command.startsWith('command -v')) return { code: 1, stdout: '', stderr: '' }
          const r = JSON.parse(options!.stdin!)
          requests.push(r.operation)
          if (r.operation === 'start') {
            if (!operations.has(r.operationId)) {
              const steps = r.steps.map((step: any, index: number) => {
                const change = step.request.change
                const after = {
                  state: 'installed',
                  version: change.target?.version ?? change.before.version,
                  targetIdentity: change.target?.targetIdentity ?? change.before.targetIdentity,
                  packages: change.target?.packages ?? [],
                  healthy: true,
                }
                installed.set(change.software, after)
                return {
                  ordinal: index + 1,
                  software: change.software,
                  state: 'succeeded',
                  changes: change.target?.packages ?? [],
                  after,
                }
              })
              operations.set(r.operationId, {
                state: fail ? 'failed' : 'completed',
                steps,
                error: fail ? 'second operation failed' : undefined,
              })
            }
            return ok(unknown ? { state: 'unknown', steps: [] } : operations.get(r.operationId))
          }
          if (r.operation === 'recover')
            return ok(
              unknown
                ? { state: 'unknown', steps: [] }
                : (operations.get(r.operationId) ?? {
                    state: 'not-started',
                    steps: [],
                  }),
            )
          if (r.operation === 'detect')
            return ok({
              operation: r.operation,
              result: installed.get(r.software) ?? { state: 'missing' },
            })
          if (r.operation === 'list-candidates')
            return ok({
              operation: r.operation,
              candidates: [target(r.software)],
            })
          if (r.operation === 'resolve')
            return ok({
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
                payload: { packages: r.target.packages },
              },
              additionalRequirements: [],
            })
          throw Error('unexpected request ' + r.operation)
        },
      })
      return {
        connect,
        installed,
        requests,
        operations,
        setUnknown(value: boolean) {
          unknown = value
        },
        fail() {
          fail = true
        },
        setOs(value: string) {
          os = value
        },
      }
    }
    async function next(target: ReturnType<typeof remote>) {
      const job = await claimNext(db, 'worker-one')
      assert.ok(job)
      await executeJob(db, secrets, definitions, job, target.connect)
      return job
    }
    const getJob = async (id: string) => (await pool.query('select * from server_jobs where id=$1', [id])).rows[0]
    await t.test('container inspection errors remain visible and do not mark SSH offline', async () => {
      const created = (await api('POST', '/servers', input())).body
      const target = remote(), connect = target.connect
      target.connect = async () => {
        const session = await connect(), exec = session.exec.bind(session)
        session.exec = async (command, timeout, options) => command.startsWith('command -v')
          ? { code: 0, stdout: '', stderr: '' }
          : command.startsWith('docker version')
            ? { code: 1, stdout: '', stderr: 'permission denied: docker socket' }
            : exec(command, timeout, options)
        return session
      }
      await api('POST', `/servers/${created.id}/inspect`)
      const job = await next(target), saved = await getJob(job.id)
      assert.equal(saved.state, 'failed')
      assert.equal(saved.result.summary, 'inspection_issues')
      assert.equal(saved.result.issues[0].code, 'containers_failed')
      assert.match(saved.result.issues[0].params.detail, /permission denied/)
      const detail = (await api('GET', `/servers/${created.id}`)).body
      assert.equal(detail.reachability, 'online')
      assert.equal(detail.containers_state, 'failed')
      assert.equal((await pool.query('select failed from server_inspection_reports where server_identity=$1', [created.id])).rows[0].failed, 1)
    })
    await t.test('vacant registration needs no software; OS and credentials remain separate', async () => {
      const created = await api('POST', '/servers', input({ install_required_software: true }))
      assert.equal(created.status, 201)
      assert.equal(created.body.type_key, VACANT_TYPE)
      assert.equal(created.body.install_required_software, false)
      assert.equal(created.body.jobs, undefined)
      assert.equal(created.body.secret_ciphertext, undefined)
      assert.equal((await api('POST', '/servers', input({ declared_os: undefined }))).body.code, 'os_required')
      assert.equal(
        (
          await api(
            'POST',
            '/servers',
            input({
              declared_os: {
                kind: 'catalog',
                family: 'builtin/windows-server',
                releaseKey: '2025',
              },
              type_key: GENERAL_TYPE,
            }),
          )
        ).body.code,
        'os_type_unsupported',
      )
      const check = await api('POST', `/servers/${created.body.id}/test`)
      assert.equal(check.status, 202)
      const job = await next(remote())
      assert.equal((await getJob(job.id)).state, 'succeeded')
    })
    await t.test(
      'whole-bundle registration rolls back on invalid references, persists identity and drains leases',
      async () => {
        const invalid = definitions.registerDefinitions({
          ...bundle,
          groups: [
            ...bundle.groups!,
            {
              key: 'bad',
              name: { zh: '坏', en: 'Bad' },
              types: ['absent/type'],
            },
          ],
        })
        await assert.rejects(invalid.ready, { code: 'definition_reference' })
        assert.equal((await pool.query("select count(*) from server_groups where kind='system'")).rows[0].count, '0')
        const registration = definitions.registerDefinitions(bundle)
        await registration.ready
        const id = await groupId()
        assert.equal((await api('DELETE', `/groups/${id}`)).status, 403)
        const lease = await definitions.lease(id, '@test/provider/node')
        assert.ok(lease)
        let done = false
        const disposal = registration.dispose().then(() => {
          done = true
        })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(done, false)
        assert.equal(await definitions.lease(id, '@test/provider/node'), undefined)
        lease.release()
        await disposal
        const again = definitions.registerDefinitions(bundle)
        await again.ready
        assert.equal(await groupId(), id)
        await registration.dispose()
        assert.equal((await definitions.options(id)).available, true)
        await again.dispose()
      },
    )
    await t.test('contributor ownership is checked and Cordis unload awaits registration cleanup', async () => {
      const root = new Context(),
        provided = root.provide('serverManagement', new ServerManagement(root, definitions))
      const fiber = root.plugin({
        name: '@test/provider',
        inject: ['serverManagement'],
        async apply(ctx: Context) {
          const registration = ctx.serverManagement.registerDefinitions(bundle)
          await registration.ready
        },
      })
      await fiber
      assert.equal((await definitions.options(await groupId())).available, true)
      await fiber.dispose()
      assert.equal((await definitions.options(await groupId())).available, false)
      assert.throws(() => root.serverManagement.registerDefinitions(bundle), {
        code: 'definition_owner',
      })
      await provided()
    })
    await t.test(
      'cross-provider leases become unavailable on unload and retain accepted scripts until drained',
      async () => {
        const provider = definitions.registerDefinitions({
          ...bundle,
          groups: [],
          types: [],
        })
        await provider.ready
        const consumer = definitions.registerDefinitions({
          contractVersion: 2,
          owner: '@test/consumer',
          types: [{ ...bundle.types![0]!, key: 'consumer' }],
          groups: [
            {
              key: 'consumer',
              name: { zh: '消费者', en: 'Consumer' },
              types: ['@test/consumer/consumer'],
            },
          ],
        })
        await consumer.ready
        const id = await groupId('@test/consumer'),
          lease = await definitions.lease(id, '@test/consumer/consumer')
        assert.ok(lease)
        let done = false
        const disposal = provider.dispose().then(() => {
          done = true
        })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(done, false)
        assert.equal((await definitions.options(id)).available, false)
        lease.release()
        await disposal
        await consumer.dispose()
      },
    )
    await t.test('automatic preparation creates a separate exact plan; connection checks never install', async () => {
      const target = remote(),
        created = await api('POST', '/servers', input({ type_key: GENERAL_TYPE, install_required_software: true }))
      assert.equal(created.status, 201)
      const inspected = await next(target)
      assert.equal(inspected.purpose, 'inspect')
      assert.equal(target.requests.includes('start'), false)
      const planned = (await pool.query('select * from server_change_plans')).rows[0]
      assert.equal(planned.authorization_kind, 'missing_software_only')
      assert.equal(planned.request_snapshot.plan.changes[0].target.packages[0].version, '1:1.2.3-1')
      const applied = await next(target)
      assert.equal(applied.purpose, 'apply_plan')
      assert.equal((await getJob(applied.id)).state, 'succeeded')
      assert.equal(target.requests.filter((x) => x === 'start').length, 1)
      const detail = (await api('GET', `/servers/${created.body.id}`)).body
      assert.equal(detail.software_state, 'ready')
      assert.equal(detail.config_revision, created.body.config_revision)
      await api('POST', `/servers/${created.body.id}/test`)
      await next(target)
      assert.equal(await claimNext(db, 'worker-one'), undefined)
    })
    await t.test(
      'saving identified information schedules a read-only check without trusting browser versions',
      async () => {
        const before = Number((await pool.query('select count(*) from server_change_plans')).rows[0].count)
        const target = remote()
        const created = (
          await api(
            'POST',
            '/servers',
            input({
              type_key: GENERAL_TYPE,
              install_required_software: false,
              inspect_after_save: true,
              software_status: { docker: { state: 'installed', version: 'forged' } },
            }),
          )
        ).body
        assert.equal(created.software_status.docker.version, undefined)
        const inspected = await next(target)
        assert.equal(inspected.purpose, 'inspect')
        assert.equal((await getJob(inspected.id)).state, 'succeeded')
        assert.equal(target.requests.includes('start'), false)
        assert.equal(Number((await pool.query('select count(*) from server_change_plans')).rows[0].count), before)
        assert.equal((await api('GET', `/servers/${created.id}`)).body.software_status.docker.state, 'missing')
        assert.equal(
          (await api('PATCH', `/servers/${created.id}`, { name: 'checked again', inspect_after_save: true })).status,
          200,
        )
        await next(target)
        assert.equal(await claimNext(db, 'worker-one'), undefined)
      },
    )
    await t.test(
      'unknown recovery holds the server lock; provider unload does not prevent journal reconciliation',
      async () => {
        const registration = definitions.registerDefinitions(bundle)
        await registration.ready
        const target = remote(),
          created = (
            await api(
              'POST',
              '/servers',
              input({
                group_id: await groupId(),
                install_required_software: true,
              }),
            )
          ).body
        await next(target)
        target.setUnknown(true)
        const job = await next(target)
        assert.equal((await getJob(job.id)).state, 'recovering')
        assert.equal((await api('PATCH', `/servers/${created.id}`, { ssh_port: 2222 })).body.code, 'server_busy')
        assert.equal(
          (
            await api('PATCH', `/servers/${created.id}`, {
              name: 'display only',
            })
          ).status,
          200,
        )
        await registration.dispose()
        target.setUnknown(false)
        await pool.query("update server_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [job.id])
        const recovery = await next(target)
        assert.equal(recovery.id, job.id)
        assert.notEqual(recovery.fence, job.fence)
        assert.equal((await getJob(job.id)).state, 'succeeded')
        assert.equal(target.requests.filter((x) => x === 'start').length, 1)
        await assert.rejects(finishJob(db, job, 'failed', 'stale writer'), {
          code: 'job_lease_lost',
        })
      },
    )
    await t.test('recovery releases the server lock when the remote operation never started', async () => {
      const target = remote(),
        created = (
          await api(
            'POST',
            '/servers',
            input({
              type_key: GENERAL_TYPE,
              install_required_software: true,
            }),
          )
        ).body
      await next(target)
      const pending = await claimNext(db, 'worker-one')
      assert.ok(pending)
      await phase(db, pending, 'installing')
      await pool.query("update server_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [pending.id])
      const recovered = await next(target)
      assert.equal(recovered.id, pending.id)
      assert.equal((await getJob(pending.id)).state, 'failed')
      assert.equal(target.requests.includes('start'), false)
      assert.equal(
        (await api('PATCH', `/servers/${created.id}`, { ssh_port: 2222, install_required_software: false })).status,
        200,
      )
    })
    await t.test('critical configuration drift blocks a queued plan before remote mutation', async () => {
      const target = remote(),
        created = (
          await api(
            'POST',
            '/servers',
            input({
              type_key: GENERAL_TYPE,
              install_required_software: true,
            }),
          )
        ).body
      await next(target)
      assert.equal(
        (
          await api('PATCH', `/servers/${created.id}`, {
            install_required_software: false,
            ssh_port: 2222,
          })
        ).status,
        200,
      )
      const job = await next(target)
      assert.equal((await getJob(job.id)).state, 'failed')
      assert.equal(target.requests.includes('start'), false)
    })
    await t.test('OS mismatch records evidence and blocks software; correction remains possible', async () => {
      const target = remote()
      target.setOs('ID=debian\nVERSION_ID=12\nSMP_ARCH=x86_64\n')
      const created = (await api('POST', '/servers', input({ type_key: GENERAL_TYPE }))).body
      await api('POST', `/servers/${created.id}/install-components`)
      const job = await next(target)
      assert.equal((await getJob(job.id)).state, 'failed')
      assert.deepEqual(target.requests, [])
      assert.equal((await api('GET', `/servers/${created.id}`)).body.os_verification, 'mismatch')
      assert.equal(
        (
          await api('PATCH', `/servers/${created.id}`, {
            declared_os: {
              kind: 'catalog',
              family: 'builtin/debian',
              releaseKey: '12',
            },
          })
        ).status,
        200,
      )
      await next(target)
    })
    await t.test('concurrent claims serialize per server and stale fences cannot finish a recovered task', async () => {
      const created = (await api('POST', '/servers', input())).body
      await enqueue(db, created.id, 'inspect')
      await enqueue(db, created.id, 'test_connection')
      const jobs = (await Promise.all([claimNext(db, 'worker-a'), claimNext(db, 'worker-b')])).filter(
        (j): j is JobRecord => !!j,
      )
      assert.equal(jobs.length, 1)
      await pool.query("update server_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [jobs[0]!.id])
      const recovered = await claimNext(db, 'worker-c')
      assert.equal(recovered?.id, jobs[0]!.id)
      assert.equal(recovered?.state, 'recovering')
      await assert.rejects(finishJob(db, jobs[0]!, 'succeeded', 'stale'), {
        code: 'job_lease_lost',
      })
      await executeJob(db, secrets, definitions, recovered!, remote().connect)
      await next(remote())
    })
    await t.test('deleting a server preserves immutable task identity and execution history', async () => {
      const created = (await api('POST', '/servers', input())).body
      await api('POST', `/servers/${created.id}/test`)
      const job = await next(remote())
      assert.equal((await api('DELETE', `/servers/${created.id}`)).status, 204)
      const retained = await getJob(job.id)
      assert.equal(retained.server_id, null)
      assert.equal(retained.server_identity, created.id)
    })
  },
)
