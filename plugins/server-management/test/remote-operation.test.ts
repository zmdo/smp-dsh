import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { REMOTE_SUPERVISOR } from '../src/remote-operation.ts'
import { APT_RECIPE } from '../src/builtin-recipes.ts'
import { quote } from '../src/recipe.ts'
function python(
  source: string,
  input: unknown,
  env = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', source], { env }),
      out: Buffer[] = [],
      err: Buffer[] = []
    child.stdout.on('data', (v) => out.push(v))
    child.stderr.on('data', (v) => err.push(v))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }),
    )
    child.stdin.end(JSON.stringify(input))
  })
}
const script = (body: string) => ({ interpreter: 'posix-sh', body, timeoutMs: 1000, outputLimitBytes: 4096 })
const response = (value: unknown) => `printf '%s' ${quote(JSON.stringify(value))}`
test(
  'detached remote journal serializes jobs, deduplicates operation IDs and records every software step',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'smp-remote-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    // Run the real supervisor in an isolated user-owned test directory; production retains its root ownership checks.
    const source = REMOTE_SUPERVISOR.replace("ROOT='/var/lib/smp-server-management'", `ROOT=${JSON.stringify(root)}`)
      .replace("if os.geteuid()!=0:raise RuntimeError('root_required')", "if False:raise RuntimeError('root_required')")
      .replace('st.st_uid!=0', 'st.st_uid!=os.geteuid()')
    const operationId = randomUUID(),
      digest = 'frozen-plan',
      steps = [1, 2].map((index) => {
        const marker = join(root, `marker-${index}`),
          software = `test/software-${index}`,
          after = { state: 'installed', version: '1.0.0', targetIdentity: software + '=1', packages: [], healthy: true }
        const detect = script(
          `if [ -f ${quote(marker)} ]; then ${response({ operation: 'detect', result: after })}; else ${response({ operation: 'detect', result: { state: 'missing' } })}; fi`,
        )
        return {
          environment: { software },
          request: {
            change: {
              software,
              action: 'install',
              before: { state: 'missing' },
              target: { targetIdentity: after.targetIdentity },
            },
          },
          detect,
          execute: script(
            `sleep 0.2; printf x >> ${quote(marker)}; ${response({ operation: 'execute', state: 'completed', changes: [{ software }] })}`,
          ),
          verify: script(response({ operation: 'verify', result: after, healthy: true })),
        }
      })
    const request = { operation: 'start', operationId, digest, steps }
    const started = await python(source, request)
    assert.equal(started.code, 0, started.stderr)
    assert.equal(JSON.parse(started.stdout).state, 'running')
    const busy = await python(source, { ...request, operationId: randomUUID() })
    assert.equal(busy.code, 1)
    assert.match(busy.stderr, /remote_busy/)
    const duplicate = await python(source, request)
    assert.equal(duplicate.code, 0)
    let result: any
    for (let i = 0; i < 80; i++) {
      result = JSON.parse((await python(source, { operation: 'recover', operationId, digest })).stdout)
      if (result.state !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.equal(result.state, 'completed')
    assert.deepEqual(
      result.steps.map((s: any) => s.ordinal),
      [1, 2],
    )
    for (const i of [1, 2]) assert.equal(await readFile(join(root, `marker-${i}`), 'utf8'), 'x')
    assert.equal(JSON.parse((await python(source, request)).stdout).state, 'completed')
    assert.equal((await python(source, { ...request, digest: 'different-plan' })).code, 1)
    const interrupted = randomUUID()
    await mkdir(join(root, interrupted))
    await writeFile(
      join(root, interrupted, 'result.json'),
      JSON.stringify({ state: 'running', digest: 'interrupted', steps: [] }),
    )
    await writeFile(join(root, 'active'), JSON.stringify({ operationId: interrupted }))
    assert.equal(
      JSON.parse(
        (await python(source, { operation: 'recover', operationId: interrupted, digest: 'interrupted' })).stdout,
      ).state,
      'unknown',
    )
    const blocked = await python(source, { ...request, operationId: randomUUID() })
    assert.equal(blocked.code, 1)
    assert.match(blocked.stderr, /previous_operation_unresolved/)
  },
)
test(
  'remote partial failure retains prior successes and probes the failing software',
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'smp-partial-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const source = REMOTE_SUPERVISOR.replace("ROOT='/var/lib/smp-server-management'", `ROOT=${JSON.stringify(root)}`)
      .replace("if os.geteuid()!=0:raise RuntimeError('root_required')", "if False:raise RuntimeError('root_required')")
      .replace('st.st_uid!=0', 'st.st_uid!=os.geteuid()')
    const operationId = randomUUID(),
      digest = 'failed-plan',
      after = { state: 'installed', version: '1.0.0', targetIdentity: 'first=1', packages: [], healthy: true }
    const steps = [
      {
        environment: { software: 'first' },
        request: { change: { software: 'first', action: 'keep', before: after } },
        detect: script(response({ operation: 'detect', result: after })),
      },
      {
        environment: { software: 'second' },
        request: {
          change: {
            software: 'second',
            action: 'install',
            before: { state: 'missing' },
            target: { targetIdentity: 'second=1' },
          },
        },
        detect: script(response({ operation: 'detect', result: { state: 'missing' } })),
        execute: script(
          response({ operation: 'execute', state: 'failed', changes: [{ name: 'dependency', version: '2.0.0' }] }),
        ),
        verify: script('exit 1'),
      },
    ]
    await python(source, { operation: 'start', operationId, digest, steps })
    let result: any
    for (let i = 0; i < 50; i++) {
      result = JSON.parse((await python(source, { operation: 'recover', operationId, digest })).stdout)
      if (result.state !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.equal(result.state, 'failed')
    assert.equal(result.steps[0].state, 'succeeded')
    assert.equal(result.steps[1].changes[0].name, 'dependency')
    assert.equal(result.steps[1].after.state, 'missing')
  },
)
test('built-in apt protocol parses exact epochs and dependencies without touching the host package manager', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'smp-apt-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stub = `#!/usr/bin/env python3
import sys,os
name=os.path.basename(sys.argv[0]);args=sys.argv[1:]
if name=='apt-cache':
 if args[0]=='madison':
  if args[1]=='docker-ce':print(' docker-ce | 5:27.3.1-1 | repository')
 elif args[0]=='show':
  package,version=args[1].split('=',1);print('Package: '+package+'\\nVersion: '+version+'\\nArchitecture: amd64\\nFilename: pool/'+package+'.deb\\nSHA256: '+'a'*64)
elif name=='apt-get':
 if '--simulate' not in args:raise RuntimeError('fixture refuses mutations')
 print('Inst docker-ce (5:27.3.1-1 repository [amd64])\\nInst dependency (1.0.0-1 repository [amd64])\\nConf docker-ce (5:27.3.1-1 repository [amd64])')
elif name=='dpkg-query':sys.exit(1)
else:sys.exit(127)
`
  for (const name of ['apt-cache', 'apt-get', 'dpkg-query', 'docker'])
    await writeFile(join(directory, name), stub, { mode: 0o700 })
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    base = {
      contractVersion: 2,
      software: 'builtin/docker-engine',
      recipe: 'builtin/docker-apt',
      recipeRevision: 'revision',
      effectiveVersions: { kind: 'any' },
    }
  const detected = await python(APT_RECIPE, { ...base, operation: 'detect' }, env)
  assert.equal(detected.code, 0, detected.stderr)
  const candidates = await python(
    APT_RECIPE,
    { ...base, operation: 'list-candidates', installed: { state: 'missing' } },
    env,
  )
  assert.equal(candidates.code, 0, candidates.stderr)
  const candidate = JSON.parse(candidates.stdout).candidates[0]
  assert.equal(candidate.version, '27.3.1')
  assert.equal(candidate.packages[0].version, '5:27.3.1-1')
  const resolved = await python(
    APT_RECIPE,
    { ...base, operation: 'resolve', target: candidate, installed: { state: 'missing' } },
    env,
  )
  assert.equal(resolved.code, 0, resolved.stderr)
  assert.equal(JSON.parse(resolved.stdout).change.payload.packages.length, 2)
})
