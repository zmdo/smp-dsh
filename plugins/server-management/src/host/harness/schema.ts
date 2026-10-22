import type { ServerDisplayStatus } from '../../shared/server-status.ts'

export const SERVER_STATUSES = [
  'unverified',
  'normal',
  'disconnected',
  'installing',
  'upgrading',
  'attention',
] as const satisfies readonly ServerDisplayStatus[]

export const listParameters = {
  query: {
    type: 'string',
    description: 'Optional words to match against managed server name, host, group, type or OS.',
  },
  status: {
    type: 'string',
    enum: SERVER_STATUSES,
    description: 'Optional platform display status filter.',
  },
  limit: {
    type: 'integer',
    description: 'Maximum number of servers to return, from 1 to 50. Defaults to 20.',
  },
} as const

export const getParameters = {
  server: {
    type: 'string',
    required: true,
    description: 'Managed server id, or its exact server name.',
  },
} as const

export const execParameters = {
  server: {
    type: 'string',
    required: true,
    description: 'Managed server id or exact server name.',
  },
  command: {
    type: 'string',
    required: true,
    description: 'Shell command to run through the platform SSH credentials. Maximum 8192 characters.',
  },
  timeout_ms: {
    type: 'integer',
    description: 'Execution timeout in milliseconds, from 1 to 120000. Defaults to 30000.',
  },
} as const

export const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}
