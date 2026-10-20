import type { Json } from '../../shared/contracts/common.ts'
import type { ServerDto } from '../../shared/dto/servers.ts'

/** Host-only callbacks. They never cross the client contract boundary. */
export interface ServerExtensionRuntime {
  queries?: Record<string, (server: ServerDto, search: URLSearchParams) => Promise<Json>>
  settings?: Record<string, { defaults: Json; validate(value: unknown): Json }>
}
