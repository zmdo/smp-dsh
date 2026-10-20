import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Deps } from '../dependencies.ts'
import { HttpError } from '../errors.ts'
import { UUID } from '../input.ts'
import { serverList } from '../servers/list.ts'
import {
  containersOf,
  createServer,
  deleteServer,
  enqueueExisting,
  serverDetail,
  updateServer,
} from '../servers/service.ts'
import { jobView } from '../tasks/queries.ts'
import { readJson, sendJson } from './reply.ts'
import { parseServerListQuery } from './server-query.ts'

export async function routeServers(
  deps: Deps,
  request: IncomingMessage,
  response: ServerResponse,
  rest: string,
): Promise<void> {
  if (rest === '' && request.method === 'GET')
    return sendJson(
      response,
      200,
      await serverList(
        deps,
        parseServerListQuery(new URL(request.url ?? '/', 'http://localhost').searchParams),
      ),
    )
  if (rest === '' && request.method === 'POST')
    return sendJson(response, 201, await createServer(deps, await readJson(request)))
  if (rest === '/test-connection' && request.method === 'POST')
    return sendJson(response, 200, await deps.enrollment.test(await readJson(request)))
  if (rest === '/identify-system' && request.method === 'POST')
    return sendJson(response, 200, await deps.enrollment.identify(await readJson(request)))
  const parts = rest.split('/').filter(Boolean)
  const id = parts[0] ?? ''
  if (!UUID.test(id)) throw new HttpError(404, 'server_not_found')
  if (parts.length === 1 && request.method === 'GET')
    return sendJson(response, 200, await serverDetail(deps, id))
  if (parts.length === 1 && request.method === 'PATCH')
    return sendJson(response, 200, await updateServer(deps, id, await readJson(request)))
  if (parts.length === 1 && request.method === 'DELETE') {
    await deleteServer(deps.db, id)
    response.writeHead(204)
    response.end()
    return
  }
  if (parts.length === 2 && parts[1] === 'containers' && request.method === 'GET')
    return sendJson(response, 200, await containersOf(deps.db, id))
  const action =
    parts.length === 2
      ? (
          {
            test: 'test_connection',
            inspect: 'inspect',
            'install-components': 'install_components',
          } as Record<string, string>
        )[parts[1]!]
      : undefined
  if (action !== undefined && request.method === 'POST')
    return sendJson(response, 202, jobView(await enqueueExisting(deps, id, action)))
  throw new HttpError(404, 'server_not_found')
}
