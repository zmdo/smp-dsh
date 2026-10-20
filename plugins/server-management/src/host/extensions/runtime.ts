import type { Json } from '../../shared/contracts/common.ts'
import type { ServerDto } from '../../shared/dto/servers.ts'
import type { DeclaredOs } from '../../shared/operating-system-types.ts'
import type { DbClient } from '../database/connection.ts'

/** Host-only callbacks. They never cross the client contract boundary. */
export interface ServerExtensionRuntime {
  queries?: Record<string, (server: ServerDto, search: URLSearchParams) => Promise<Json>>
  settings?: Record<string, { defaults: Json; validate(value: unknown): Json }>
  inspections?: Record<string, {
    validate(raw: string): Json
    commit?(db: DbClient, server: ExtensionInspectionServer, result: Json): Promise<void>
  }>
}
