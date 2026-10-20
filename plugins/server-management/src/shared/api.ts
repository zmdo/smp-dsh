import type { ChangeRequest, PreparedPlan } from './changes.ts'
import type { GroupView, LocalizedText, SoftwareView } from './definitions.ts'
import type { DetectionResult } from './detection-result.ts'
import type { DeclaredOs, DetectedOs, OsSupport } from './operating-system-types.ts'
import type { SoftwarePolicy } from './policies.ts'
import type { DisplayStatus } from './server-list-contract.ts'
export interface ServerRow {
  id: string
  software_policies: SoftwarePolicy[]
  upgrade_count: number
  name: string
  host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  group_id: string | null
  group_name: string | null
  group_name_i18n: LocalizedText | null
  type_key: string
  type_name_i18n: LocalizedText
  type_available: boolean
  required_software: SoftwareView[]
  software_state: string
  region: string | null
  install_required_software: boolean
  declared_os: DeclaredOs
  detected_os: DetectedOs | null
  os_verification: string
  type_supported_os: OsSupport
  software_status: Record<
    string,
    {
      state?: string
      installed?: boolean
      detail?: string
      version?: string
      last_known_version?: string
      revision?: string
    }
  >
  host_fingerprint: string | null
  reachability: string
  status: DisplayStatus
  docker_version: string | null
  compose_version: string | null
  cpu_percent: number | null
  mem_total_bytes: number | string | null
  mem_used_bytes: number | string | null
  disk_total_bytes: number | string | null
  disk_used_bytes: number | string | null
  last_checked_at: string | null
  container_count: number | null
  containers_state: string
  containers_checked_at: string | null
  containers?: ContainerRow[]
}

export interface ContainerRow {
  container_id: string
  name: string
  image: string
  status: string
  ports: string
}

export interface GroupRow extends GroupView {
  server_count: number
}

export interface KeyRow {
  id: string
  name: string
  fingerprint: string
}

export interface Suggestion {
  id: string
  server_id: string
  server_name: string
  host: string
  software_key: string
  product_version: string
  group_id: string | null
  type_key: string
  connection_state: string
  decision: string
  reminder_after: string | null
  scheduled: boolean
  basis_snapshot: { before: { version: string } }
  reason: { major: boolean; code?: string }
  validity: string
}
export interface Suggestions {
  items: Suggestion[]
  total: number
  page: number
  page_size: number
  filtered_server_ids: string[]
  checks: DetectionResult[]
}
export interface Inventory {
  type_name_i18n: LocalizedText
  required_software: SoftwareView[]
  id: string
  name: string
  group_id: string | null
  type_key: string
}
export interface PlanSummary {
  id: string
  kind: string
  state: string
  created_at: string
  target_count: number
  succeeded_count: number
  running_count: number
}
export interface RecordPage {
  items: {
    id: string
    state: string
    plan_id: string
    server_snapshot: { name: string }
    created_at: string
    finished_at: string | null
    output_excerpt: string
    result: unknown
    steps: unknown[]
  }[]
  total: number
}
export interface PlanView {
  id: string
  kind: string
  state: string
  revision: string
  review_digest: string
  request_snapshot: ChangeRequest
  window_start: string | null
  window_end: string | null
  targets: {
    id: string
    server_id: string
    server_snapshot: { name: string; host: string }
    state: string
    preflight_state: string
    preflight_error: unknown
    target_snapshot: PreparedPlan
    result: unknown
  }[]
}
