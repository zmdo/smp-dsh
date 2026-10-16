import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Pool } from 'pg'
import { accountFromCookie, decideLogin, ensureAccount, findAccount, passwordIsDefault, type AccountRow } from './account.ts'
import { clearDshCookieHeaders, dshAuthCookieNames, indexGate, smpSessionValue, tokenExchangeUrl } from './gate.ts'
import { LOGIN_PAGE } from './login-page.ts'
import { clearSessionCookie, openSession, sealSession, sessionCookie } from './session.ts'

interface IndexRequest {
  method?: string
  url?: string
  headers: { cookie?: string | string[] }
}

interface IndexResponse {
  setHeader?(name: string, value: string | readonly string[]): void
  writeHead(status: number, headers?: Record<string, string | readonly string[]>): unknown
  end(body?: string): unknown
}

interface Admission {
  rejection?: number
}

interface ConnectionService {
  authorizeIndex(request: IndexRequest, response: IndexResponse): boolean
  authenticatedUrl(baseUrl: string): string
  admit(request: IndexRequest): Admission
}

/** Read a console session. Column plugins call this instead of parsing the cookie. */
export class ConsoleSession extends Service {
  private readonly pool: Pool
  private readonly secret: string

  constructor(ctx: Context, pool: Pool, secret: string) {
    super(ctx, 'consoleSession')
    this.pool = pool
    this.secret = secret
  }

  read(cookieHeader: string): Promise<AccountRow | undefined> {
    return accountFromCookie(this.pool, this.secret, cookieHeader)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    consoleSession: ConsoleSession
  }
}

interface HostCtx extends Context {
  connection: ConnectionService
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }): () => void
  }
  database: { pool: Pool }
}

export interface Config {
  sessionSecret: string
  initialUsername: string
  initialPassword?: string
}

export const Config: Schema<Config> = Schema.object({
  sessionSecret: String,
  initialUsername: Schema.string().default('admin'),
  initialPassword: Schema.string(),
})

export const inject = ['connection', 'webServer', 'database']

const BODY_LIMIT = 64 * 1024

function cookieHeader(request: { headers: { cookie?: string | string[] } }): string {
  const value = request.headers.cookie
  return Array.isArray(value) ? value.join('; ') : value ?? ''
}

function launchToken(connection: ConnectionService): string | undefined {
  return new URL(connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token') ?? undefined
}

function expirePageConnection(response: IndexResponse, header: string): void {
  const clearing = clearDshCookieHeaders(dshAuthCookieNames(header))
  if (clearing.length > 0) response.setHeader?.('set-cookie', clearing)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error('body')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sendJson(response: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const headers: Record<string, string | readonly string[]> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (cookie !== undefined) headers['set-cookie'] = cookie
  response.writeHead(status, headers)
  response.end(JSON.stringify(body))
}

function field(body: unknown, name: string): string | undefined {
  if (body === null || typeof body !== 'object' || !(name in body)) return undefined
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * authorizeIndex cannot wait, so the index gate trusts the signature only.
 * Issuing the cookie and reading an account both go through the database.
 * The generator is the plugin effect: a nested effect would keep the fiber
 * active when the first account cannot be created.
 */
export async function* apply(ctx: HostCtx, config: Config): AsyncGenerator<() => void> {
  await ensureAccount(ctx.database.pool, config)
  const secret = config.sessionSecret
  const session = new ConsoleSession(ctx, ctx.database.pool, secret)

  yield ctx.webServer.register({
    kind: 'exact',
    path: '/login',
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
        response.end()
        return
      }
      const header = cookieHeader(request)
      if (await session.read(header) !== undefined) {
        response.writeHead(303, { location: '/', 'cache-control': 'no-store' })
        response.end()
        return
      }
      const clearing = clearDshCookieHeaders(dshAuthCookieNames(header))
      const headers: Record<string, string | readonly string[]> = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      }
      if (clearing.length > 0) headers['set-cookie'] = clearing
      response.writeHead(200, headers)
      response.end(request.method === 'HEAD' ? undefined : LOGIN_PAGE)
    },
  })

  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/auth/login',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
        response.end()
        return
      }
      let body: unknown
      try {
        body = await readJson(request)
      } catch (error) {
        void error
        sendJson(response, 400, { detail: '请求无法读取' })
        return
      }
      const username = field(body, 'username')?.trim() ?? ''
      const password = field(body, 'password') ?? ''
      const account = username === '' ? undefined : await findAccount(ctx.database.pool, username)
      const decision = decideLogin(account, password, field(body, 'totp_code'))
      if (decision.kind === 'unauthorized') {
        sendJson(response, 401, { detail: decision.detail })
        return
      }
      if (decision.kind === 'totp') {
        sendJson(response, 200, { ok: false, totp_required: true })
        return
      }
      sendJson(response, 200, { ok: true }, sessionCookie(sealSession(decision.username, secret)))
    },
  })

  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/auth/logout',
    handler: (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
        response.end()
        return
      }
      response.writeHead(204, { 'set-cookie': clearSessionCookie(), 'cache-control': 'no-store' })
      response.end()
    },
  })

  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/auth/me',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
        response.end()
        return
      }
      const account = await session.read(cookieHeader(request))
      if (account === undefined) {
        sendJson(response, 200, { authenticated: false, password_is_default: false, totp_enabled: false })
        return
      }
      sendJson(response, 200, {
        authenticated: true,
        username: account.username,
        password_is_default: passwordIsDefault(account.password_hash),
        totp_enabled: account.totp_enabled,
      })
    },
  })

  yield ctx.webServer.register({
    kind: 'exact',
    path: '/console-api/auth/session',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (await session.read(cookieHeader(request)) === undefined) {
        sendJson(response, 401, { detail: '未登录' })
        return
      }
      sendJson(response, 200, { ok: true })
    },
  })

  const connection = ctx.connection
  const original = connection.authorizeIndex.bind(connection)
  connection.authorizeIndex = (request, response) => {
    const header = cookieHeader(request)
    const signedIn = openSession(smpSessionValue(header) ?? '', secret) !== undefined
    const gate = indexGate(signedIn, !('rejection' in connection.admit(request)))
    if (gate === 'login') {
      expirePageConnection(response, header)
      response.writeHead(303, { location: '/login', 'cache-control': 'no-store' })
      response.end()
      return false
    }
    if (gate === 'app') return original(request, response)
    const token = launchToken(connection)
    if (token === undefined || request.method !== 'GET') return original(request, response)
    return original({
      method: request.method,
      url: tokenExchangeUrl(request.url ?? '/', token),
      headers: request.headers,
    }, response)
  }
  yield () => {
    connection.authorizeIndex = original
  }
}
