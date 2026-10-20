import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

test('client and shared modules depend only on their declared boundaries, including type imports', async () => {
  for (const scope of ['shared', 'client']) {
    const names = await readdir(path.join(sourceRoot, scope), { recursive: true })
    const files = names
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(sourceRoot, scope, name))
    if (scope === 'client') files.push(path.join(sourceRoot, 'client.tsx'))
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
        const specifier = match[2]!
        if (!specifier.startsWith('.')) {
          assert.equal(scope, 'client', `${file} must not import ${specifier}`)
          assert.ok(['react', '@smp/console-kit'].includes(specifier), `${file}: ${specifier}`)
          continue
        }
        const target = path.relative(sourceRoot, path.resolve(path.dirname(file), specifier))
        const allowed =
          target.startsWith('shared/') ||
          (scope === 'client' && target.startsWith('client/')) ||
          (scope === 'shared' && /^\.\.\/locale\/[^/]+\.json$/.test(target))
        assert.ok(allowed, `${file} crosses its ${scope} boundary through ${specifier}`)
      }
    }
  }
})

test('host and client entry points have no runtime module cycles', async () => {
  for (const entry of ['index.ts', 'client.tsx']) {
    const result = await build({
      absWorkingDir: sourceRoot,
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: entry === 'index.ts' ? 'node' : 'browser',
      packages: 'external',
      loader: { '.css': 'text' },
      metafile: true,
      logLevel: 'silent',
    })
    const graph = new Map(
      Object.entries(result.metafile!.inputs).map(([name, input]) => [
        name,
        input.imports.filter((item) => !item.external).map((item) => item.path),
      ]),
    )
    const visited = new Set<string>()
    const visiting: string[] = []
    function visit(name: string): void {
      assert.ok(!visiting.includes(name), `${entry}: ${[...visiting, name].join(' → ')}`)
      if (visited.has(name)) return
      visiting.push(name)
      for (const dependency of graph.get(name) ?? []) visit(dependency)
      visiting.pop()
      visited.add(name)
    }
    for (const name of graph.keys()) visit(name)
  }
})

test('HTTP, workflows and repositories preserve their host boundaries and transaction ownership', async () => {
  const names = await readdir(path.join(sourceRoot, 'host'), { recursive: true })
  for (const name of names.filter((name) => name.endsWith('.ts'))) {
    const file = path.join(sourceRoot, 'host', name),
      source = await readFile(file, 'utf8')
    const repository = /(?:^|[/\\])(?:[^/\\]+-)?repository\.ts$/.test(name)
    const http = name.startsWith('http/')
    const workflow = /(?:service|list|queries|enrollment)\.ts$/.test(name)
    if (http || workflow) assert.doesNotMatch(source, /\.query\s*(?:<|\()/, `${name} must delegate SQL`)
    if (repository) {
      assert.doesNotMatch(source, /\.connect\s*\(/, `${name} must use the caller's connection`)
      assert.doesNotMatch(
        source,
        /['"](?:begin|commit|rollback)['"]/,
        `${name} must not finish the caller's transaction`,
      )
    }
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
      const specifier = match[2]!
      if (http)
        assert.doesNotMatch(specifier, /repository\.ts$/, `${name} must call the application boundary`)
      if (workflow || repository) {
        assert.notEqual(specifier, 'node:http', `${name} must be independent of HTTP`)
        assert.doesNotMatch(specifier, /(?:^|\/)http\//, `${name} must not depend on HTTP adapters`)
      }
      if (repository)
        assert.doesNotMatch(
          specifier,
          /(?:service|queries|routes)\.ts$/,
          `${name} must not depend on workflows`,
        )
    }
  }
})
