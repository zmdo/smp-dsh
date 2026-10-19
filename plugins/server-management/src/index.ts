import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { builtinCatalog } from './catalog.ts'
import { startMetrics } from './metrics.ts'
import { routeComponents, routeGroups, routeJobs, routeKeys, routeServers, routeTypes } from './records.ts'
import { cookieHeader, sendJson } from './reply.ts'
import { executeJob } from './runner.ts'
import { claimNext, dueInspects, enqueue, HttpError, type Db } from './store.ts'
import { terminalRoute } from './terminal.ts'
import { errorPayload, ServerError } from './i18n.ts'
import { DefinitionRegistry } from './registry.ts'
import { ServerManagement } from './service.ts'

export { ServerManagement } from './service.ts'
export { VACANT_TYPE, GENERAL_TYPE } from './definitions.ts'
export type {
  DefinitionBundle,
  SystemGroupDefinition,
  ServerTypeDefinition,
  SoftwareDefinition,
  SoftwareRequirement,
  RecipeDefinition,
  ScriptDefinition,
  Registration,
  RecipeRequest,
  RecipeResponse,
  VersionRule,
  VersionAdapter,
} from './contracts.ts'
export type { LocalizedText } from './definitions.ts'
export type { DeclaredOs, DetectedOs, OsSelector, OsSupport } from './operating-systems.ts'

interface SessionService {
  read(cookieHeader: string): Promise<unknown>
}

interface HostCtx extends Context {
  database: { pool: Db }
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
  inspectIntervalSeconds: number
  metricsIntervalSeconds: number
}

export const Config: Schema<Config> = Schema.object({
  inspectIntervalSeconds: Schema.number().default(30),
  metricsIntervalSeconds: Schema.number().default(1),
})

export const inject = ['webServer', 'database', 'secrets', 'consoleSession']

const WORKERS = 4

/** Routes, the job loop, inspection, and metric sampling live in this process. */
export async function* apply(ctx: HostCtx, config: Config): AsyncGenerator<() => void | Promise<void>> {
  const catalog = builtinCatalog()
  const db = ctx.database.pool
  const definitions = new DefinitionRegistry(db, catalog)
  const deps = { db, secrets: ctx.secrets, catalog, definitions }
  yield ctx.effect(function* () {
    yield () => definitions.close()
    yield startJobs(ctx, db, config, definitions)
    yield startMetrics(db, ctx.secrets, config.metricsIntervalSeconds, (cause) => {
      ctx.logger.error(cause)
    })
    yield ctx.webServer.register({
      kind: 'exact',
      path: '/console-api/servers',
      handler: (request, response) => guard(ctx, request, response, () => routeServers(deps, request, response, '')),
    })
    yield ctx.webServer.register({
      kind: 'exact',
      path: '/console-api/servers/test-connection',
      handler: (request, response) =>
        guard(ctx, request, response, () => routeServers(deps, request, response, '/test-connection')),
    })
    yield ctx.webServer.register({
      kind: 'prefix',
      path: '/console-api/servers',
      handler: (request, response) =>
        guard(ctx, request, response, () =>
          routeServers(deps, request, response, suffix(request, '/console-api/servers')),
        ),
    })
    yield ctx.webServer.register({
      kind: 'exact',
      path: '/console-api/server-groups',
      handler: (request, response) =>
        guard(ctx, request, response, () => routeGroups(db, request, response, '', definitions)),
    })
    yield ctx.webServer.register({
      kind: 'prefix',
      path: '/console-api/server-groups',
      handler: (request, response) =>
        guard(ctx, request, response, () =>
          routeGroups(db, request, response, suffix(request, '/console-api/server-groups'), definitions),
        ),
    })
    yield ctx.webServer.register({
      kind: 'exact',
      path: '/console-api/ssh-keys',
      handler: (request, response) => guard(ctx, request, response, () => routeKeys(deps, request, response, '')),
    })
    yield ctx.webServer.register({
      kind: 'prefix',
      path: '/console-api/ssh-keys',
      handler: (request, response) =>
        guard(ctx, request, response, () =>
          routeKeys(deps, request, response, suffix(request, '/console-api/ssh-keys')),
        ),
    })
    yield ctx.webServer.register({
      kind: 'exact',
      path: '/console-api/server-types',
      handler: (request, response) => guard(ctx, request, response, () => routeTypes(definitions, request, response)),
    })
    yield ctx.webServer.register({
      kind: 'exact',
      path: '/console-api/components',
      handler: (request, response) =>
        guard(ctx, request, response, async () => {
          routeComponents(catalog, request, response)
        }),
    })
    yield ctx.webServer.register({
      kind: 'prefix',
      path: '/console-api/server-jobs',
      handler: (request, response) =>
        guard(ctx, request, response, () =>
          routeJobs(db, request, response, suffix(request, '/console-api/server-jobs')),
        ),
    })
    const terminal = terminalRoute(db, ctx.secrets, ctx.consoleSession)
    yield ctx.webServer.registerUpgrade({ path: '/console-api/servers/terminal', handler: terminal.handler })
    yield () => terminal.close()
    yield ctx.provide('serverManagement', new ServerManagement(ctx, definitions))
  })
}

function startJobs(ctx: HostCtx, db: Db, config: Config, definitions: DefinitionRegistry): () => Promise<void> {
  const workerId = randomUUID()
  let stopped = false
  let pumping = false
  let active = 0
  const tasks = new Set<Promise<void>>()
  const loops = new Set<Promise<void>>()
  const launch = (run: () => Promise<void>) => {
    const task = run()
      .catch((cause: unknown) => {
        ctx.logger.error(cause)
      })
      .finally(() => {
        loops.delete(task)
      })
    loops.add(task)
  }
  const claim = setInterval(() => {
    launch(pump)
  }, 400)
  const inspect = setInterval(() => {
    launch(queueInspects)
  }, 5000)
  launch(pump)
  return async () => {
    stopped = true
    clearInterval(claim)
    clearInterval(inspect)
    await Promise.all(loops)
    await Promise.all(tasks)
  }

  async function pump(): Promise<void> {
    if (pumping || stopped) return
    pumping = true
    try {
      while (!stopped && active < WORKERS) {
        const job = await claimNext(db, workerId)
        if (job === undefined) return
        active += 1
        const task = executeJob(db, ctx.secrets, definitions, job)
          .catch((cause: unknown) => {
            ctx.logger.error(cause)
          })
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
    for (const id of ids) {
      if (stopped) return
      await enqueue(db, id, 'inspect')
    }
  }
}

async function guard(
  ctx: HostCtx,
  request: IncomingMessage,
  response: ServerResponse,
  run: () => Promise<void>,
): Promise<void> {
  if ((await ctx.consoleSession.read(cookieHeader(request))) === undefined) {
    sendJson(response, 401, errorPayload(new ServerError('unauthorized')))
    return
  }
  try {
    await run()
  } catch (cause) {
    if (cause instanceof HttpError) {
      sendJson(response, cause.status, errorPayload(cause))
      return
    }
    if (cause instanceof ServerError) {
      sendJson(response, 422, errorPayload(cause))
      return
    }
    if (cause instanceof SyntaxError) {
      sendJson(response, 400, errorPayload(new ServerError('invalid_request')))
      return
    }
    ctx.logger.error(cause)
    if (!response.headersSent) sendJson(response, 500, errorPayload(new ServerError('request_failed')))
  }
}

function suffix(request: IncomingMessage, prefix: string): string {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  return path.startsWith(prefix) ? path.slice(prefix.length) : ''
}
