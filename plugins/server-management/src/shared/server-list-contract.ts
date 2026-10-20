import type { LocalizedText } from './contracts.ts'
import type { DeclaredOs } from './operating-systems.ts'
export const SERVER_STATES = [
  'unverified',
  'normal',
  'disconnected',
  'installing',
  'upgrading',
  'attention',
] as const
export type ServerDisplayStatus = (typeof SERVER_STATES)[number]
export type StatusReasonCode =
  | 'connection_failed'
  | 'connection_unknown'
  | 'connection_stale'
  | 'os_unverified'
  | 'os_mismatch'
  | 'type_unavailable'
  | 'os_unsupported'
  | 'software_missing'
  | 'software_unknown'
  | 'software_unhealthy'
  | 'software_version'
  | 'operation_running'
  | 'operation_recovering'
  | 'operation_expired'
export interface StatusReason {
  code: StatusReasonCode
  parameters: Record<string, string>
}
export interface DisplayStatus {
  code: ServerDisplayStatus
  reasons: StatusReason[]
  jobId: string | null
}
export interface ServerListItem {
  id: string
  name: string
  upgradeCount: number
  address: { host: string; port: number }
  operatingSystem: { declared: DeclaredOs; label: string; verification: string }
  type: { key: string; name: LocalizedText; available: boolean }
  status: DisplayStatus
  installRequiredSoftware: {
    enabled: boolean
    applicability: 'applicable' | 'not-applicable' | 'unavailable'
  }
  resources: {
    cpuPercent: number | null
    memoryUsed: string | null
    memoryTotal: string | null
    diskUsed: string | null
    diskTotal: string | null
    sampledAt: string | null
    fresh: boolean
  }
  lastCheckedAt: string | null
}
export interface ServerListPage {
  items: ServerListItem[]
  total: number
  page: number
  page_size: number
  group_id: string | null
  groups: ServerGroupSummary[]
  counts: { all: number; ungrouped: number }
}
export interface ServerGroupSummary {
  id: string
  name: string
  name_i18n: LocalizedText | null
  kind: 'user' | 'system'
  plugin_id: string | null
  available: boolean
  server_count: number
}
