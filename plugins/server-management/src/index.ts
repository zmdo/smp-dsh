import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { builtinCatalog } from './catalog.ts'
import { type Db } from './host/db.ts'
import { registerRoutes } from './host/http/routes.ts'
import { Enrollment } from './host/servers/enrollment.ts'
import { claimNext, enqueue } from './job-store.ts'
import { startMetrics } from './metrics.ts'
import { DefinitionRegistry } from './registry.ts'
import { executeJob } from './runner.ts'
import { ServerManagement } from './service.ts'
import { connectSsh } from './ssh.ts'
import { dueInspects } from './store.ts'
import { terminalRoute } from './terminal.ts'
import { scheduleChanges } from './upgrades.ts'
export { ServerManagement } from './service.ts'
export type {
  DefinitionBundle,
  LocalizedText,
  RecipeDefinition,
  RecipeRequest,
  RecipeResponse,
  Registration,
  ScriptDefinition,
  ServerTypeDefinition,
  SoftwareDefinition,
  SoftwareRequirement,
  SystemGroupDefinition,
  VersionAdapter,
  VersionRule,
} from './shared/contracts.ts'
export { GENERAL_TYPE, VACANT_TYPE } from './shared/definitions.ts'
export type {
  DeclaredOs,
  DetectedOs,
  OsSelector,
  OsSupport,
  ProbedOs,
} from './shared/operating-system-types.ts'

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
      handler: (
        request: IncomingMessage,
        socket: import('node:stream').Duplex,
        head: Buffer,
      ) => void | Promise<void>
    }): () => void
  }
}

export interface Config {
  inspectIntervalSeconds: number
  metricsIntervalSeconds: number
  sshReadyTimeoutSeconds: number
  updateCheckIntervalSeconds: number
}

export const Config: Schema<Config> = Schema.object({
  inspectIntervalSeconds: Schema.number().default(30),
  metricsIntervalSeconds: Schema.number().default(1),
  updateCheckIntervalSeconds: Schema.natural().min(60).max(604800).default(3600),
  sshReadyTimeoutSeconds: Schema.natural().min(1).max(300).default(30),
})

export const inject = ['webServer', 'database', 'secrets', 'consoleSession']

const WORKERS = 4

/** Routes, the job loop, inspection, and metric sampling live in this process. */
export async function* apply(ctx: HostCtx, config: Config): AsyncGenerator<() => void | Promise<void>> {
  const catalog = builtinCatalog()
  const db = ctx.database.pool
  const definitions = new DefinitionRegistry(db, catalog)
  const connect: typeof connectSsh = (input) =>
    connectSsh({ ...input, readyTimeoutMs: config.sshReadyTimeoutSeconds * 1000 })
  const enrollment = new Enrollment({ db, secrets: ctx.secrets, definitions }, connect)
  const deps = {
    db,
    secrets: ctx.secrets,
    catalog,
    definitions,
    enrollment,
    updateCheckIntervalSeconds: config.updateCheckIntervalSeconds,
    freshnessMs: Math.max(90, config.inspectIntervalSeconds * 3) * 1000,
  }
  yield ctx.effect(function* () {
    yield () => definitions.close()
    yield startJobs(ctx, db, config, definitions, connect)
    yield startMetrics(
      db,
      ctx.secrets,
      config.metricsIntervalSeconds,
      (cause) => {
        ctx.logger.error(cause)
      },
      connect,
    )
    yield () => enrollment.close()
    yield* registerRoutes(ctx, deps)
    const terminal = terminalRoute(db, ctx.secrets, ctx.consoleSession, connect)
    yield ctx.webServer.registerUpgrade({ path: '/console-api/servers/terminal', handler: terminal.handler })
    yield () => terminal.close()
    yield ctx.provide('serverManagement', new ServerManagement(ctx, definitions))
  })
}

function startJobs(
  ctx: HostCtx,
  db: Db,
  config: Config,
  definitions: DefinitionRegistry,
  connect: typeof connectSsh,
): () => Promise<void> {
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
    launch(() => scheduleChanges(db, config.updateCheckIntervalSeconds))
  }, 5000)
  launch(pump)
  launch(() => scheduleChanges(db, config.updateCheckIntervalSeconds))
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
        const task = executeJob(db, ctx.secrets, definitions, job, connect, config.updateCheckIntervalSeconds)
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
