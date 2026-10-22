import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execParameters, getParameters, groupListParameters, listParameters, TEXT_OUTPUT } from './schema.ts'
import { DEFAULT_EXEC_LIMITS } from './exec.ts'
import { executeHarnessCommand, type ApprovalRequester } from './exec.ts'
import { getHarnessServer, listHarnessGroups, listHarnessServers, type HarnessDeps } from './service.ts'

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
      name: 'platform_server_group_list',
      description:
        'List groups available for filtering managed servers. ' +
        'Use a returned group id or exact name with platform_server_list.',
      parameters: groupListParameters,
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        return JSON.stringify(await listHarnessGroups(deps, args))
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'platform_server_exec',
      description:
        'Run a command on one managed server through the platform SSH credentials. ' +
        'The server argument must be a managed server id or exact name; never pass an arbitrary SSH host. ' +
        'Every execution asks for approval and is audited.',
      parameters: execParameters(deps.execLimits ?? DEFAULT_EXEC_LIMITS),
      output: TEXT_OUTPUT,
      timeoutMs: 300_000,
      async execute(args, exec) {
        return executeHarnessCommand(
          deps,
          args,
          {
            agent: exec.agent,
            callId: String(exec.callId),
            rootCallId: String(exec.rootCallId),
            signal: exec.signal,
          },
          ctx.get('approval') as ApprovalRequester | undefined,
        )
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
