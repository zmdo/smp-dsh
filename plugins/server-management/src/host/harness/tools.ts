import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getParameters, listParameters, TEXT_OUTPUT } from './schema.ts'
import { getHarnessServer, listHarnessServers, type HarnessDeps } from './service.ts'

const LIST_DESCRIPTION =
  'List servers managed by this platform. Only servers returned by this tool are managed. ' +
  'Never assume localhost, an IP address or an SSH target is managed.'

const GET_DESCRIPTION =
  'Read status, operating system, software and resource observations for one managed server. ' +
  'The server argument must be a managed server id or exact server name; never pass an arbitrary SSH host.'

export function registerServerTools(ctx: Context, deps: HarnessDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'platform_server_list',
      description: LIST_DESCRIPTION,
      parameters: listParameters,
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return JSON.stringify(await listHarnessServers(deps, args))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'platform_server_get',
      description: GET_DESCRIPTION,
      parameters: getParameters,
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return JSON.stringify(await getHarnessServer(deps, args.server))
      },
    }),
  )
}
