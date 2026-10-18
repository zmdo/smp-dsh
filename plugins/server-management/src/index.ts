import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { loadCatalog } from './catalog.ts'
import { startMetrics } from './metrics.ts'
import { routeComponents, routeGroups, routeJobs, routeKeys, routeServers } from './records.ts'
import { cookieHeader, sendJson } from './reply.ts'
import { executeJob } from './runner.ts'
import { claimNext, dueInspects, enqueue, HttpError, recoverRunning, type Db } from './store.ts'
import { terminalRoute } from './terminal.ts'

interface SessionService {
  read(cookieHeader: string): Promise<unknown>
}

interface Secrets {
  encrypt(secret: string): string
  decrypt(ciphertext: string): string
}

interface HostCtx extends Context {
  database: { pool: Db }
  secrets: Secrets
  consoleSession: SessionService
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }): () => void
    registerUpgrade(route: {
      path: string
      handler: (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void | Promise<void>
    }): () => void
  }
}

export interface Config {
  componentsDir: string
  inspectIntervalSeconds: number
  metricsIntervalSeconds: number
}

export const Config: Schema<Config> = Schema.object({
  componentsDir: Schema.string().required(),
  inspectIntervalSeconds: Schema.number().default(30),
  metricsIntervalSeconds: Schema.number().default(1),
})

export const inject = ['webServer', 'database', 'secrets', 'consoleSession']

const WORKERS = 4

/** Routes, the job loop, inspection, and metric sampling live in this process. */
export async function* apply(ctx: HostCtx, config: Config): AsyncGenerator<() => void | Promise<void>> {
  await access(config.componentsDir, constants.R_OK)
  const catalog = await loadCatalog(config.componentsDir)
  const db = ctx.database.pool
  await recoverRunning(db)
  const deps = { db, secrets: ctx.secrets, catalog }
  yield startJobs(ctx, db, config)
  yield startMetrics(db, ctx.secrets, config.metricsIntervalSeconds, (cause) => { ctx.logger.error(cause) })
  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/servers',
    handler: (request, response) => guard(ctx, request, response, () => routeServers(deps, request, response, '')),
  })
  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/servers/test-connection',
    handler: (request, response) => guard(ctx, request, response, () => routeServers(deps, request, response, '/test-connection')),
  })
  yield ctx.webServer.register({
    kind: 'prefix',
    path: '/console-api/servers',
    handler: (request, response) => guard(ctx, request, response, () => routeServers(deps, request, response, suffix(request, '/console-api/servers'))),
  })
  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/server-groups',
    handler: (request, response) => guard(ctx, request, response, () => routeGroups(db, request, response, '')),
  })
  yield ctx.webServer.register({
    kind: 'prefix',
    path: '/console-api/server-groups',
    handler: (request, response) => guard(ctx, request, response, () => routeGroups(db, request, response, suffix(request, '/console-api/server-groups'))),
  })
  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/ssh-keys',
    handler: (request, response) => guard(ctx, request, response, () => routeKeys(deps, request, response, '')),
  })
  yield ctx.webServer.register({
    kind: 'prefix',
    path: '/console-api/ssh-keys',
    handler: (request, response) => guard(ctx, request, response, () => routeKeys(deps, request, response, suffix(request, '/console-api/ssh-keys'))),
  })
  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/components',
    handler: (request, response) => guard(ctx, request, response, async () => { routeComponents(catalog, request, response) }),
  })
  yield ctx.webServer.register({
    kind: 'prefix',
    path: '/console-api/ops-jobs',
    handler: (request, response) => guard(ctx, request, response, () => routeJobs(db, request, response, suffix(request, '/console-api/ops-jobs'))),
  })
  const terminal = terminalRoute(db, ctx.secrets, ctx.consoleSession)
  yield ctx.webServer.registerUpgrade({ path: '/console-api/servers/terminal', handler: terminal.handler })
  yield () => terminal.close()
}

function startJobs(ctx: HostCtx, db: Db, config: Config): () => Promise<void> {
  let stopped = false
  let pumping = false
  let active = 0
  const tasks = new Set<Promise<void>>()
  const claim = setInterval(() => { void pump().catch((cause: unknown) => { ctx.logger.error(cause) }) }, 400)
  const inspect = setInterval(() => { void queueInspects().catch((cause: unknown) => { ctx.logger.error(cause) }) }, 5000)
  void pump().catch((cause: unknown) => { ctx.logger.error(cause) })
  return async () => {
    stopped = true
    clearInterval(claim)
    clearInterval(inspect)
    await Promise.all(tasks)
  }

  async function pump(): Promise<void> {
    if (pumping || stopped) return
    pumping = true
    try {
      while (!stopped && active < WORKERS) {
        const id = await claimNext(db)
        if (id === undefined) return
        active += 1
        const task = executeJob(db, ctx.secrets, config.componentsDir, id)
          .catch((cause: unknown) => { ctx.logger.error(cause) })
          .finally(() => {
            active -= 1
            tasks.delete(task)
          })
        tasks.add(task)
      }
    } finally {
      pumping = false
    }
  }

  async function queueInspects(): Promise<void> {
    if (stopped) return
    const ids = await dueInspects(db, config.inspectIntervalSeconds)
    for (const id of ids) await enqueue(db, id, 'inspect')
  }
}

async function guard(ctx: HostCtx, request: IncomingMessage, response: ServerResponse, run: () => Promise<void>): Promise<void> {
  if (await ctx.consoleSession.read(cookieHeader(request)) === undefined) {
    sendJson(response, 401, { detail: '未登录' })
    return
  }
  try {
    await run()
  } catch (cause) {
    if (cause instanceof HttpError) {
      sendJson(response, cause.status, { detail: cause.message })
      return
    }
    if (cause instanceof SyntaxError || (cause instanceof Error && cause.message === 'too large')) {
      sendJson(response, 400, { detail: '请求无法读取' })
      return
    }
    ctx.logger.error(cause)
    if (!response.headersSent) sendJson(response, 500, { detail: '请求没有完成' })
  }
}

function suffix(request: IncomingMessage, prefix: string): string {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  return path.startsWith(prefix) ? path.slice(prefix.length) : ''
}
