import { type ServerTypeView } from '../../shared/definitions.ts'
import { type DeclaredOs, type DetectedOs } from '../../shared/operating-systems.ts'

export interface EditableServer {
  id: string
  host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  install_required_software: boolean
  declared_os: DeclaredOs
  group_id: string | null
  type_key: string
  type_snapshot: ServerTypeView | null
  type_revision: string
  config_revision: string | number
}

export interface ServerFact {
  id: string
  name: string
  host: string
  ssh_port: number
  ssh_user: string
  auth_method: string
  ssh_key_id: string | null
  group_id: string | null
  region: string
  install_required_software: boolean
  type_key: string
  type_snapshot: ServerTypeView
  type_revision: string
  config_revision: string
  declared_os: DeclaredOs
  host_fingerprint: string | null
  created_at: Date
  reachability: string
  connection_error: { message?: string } | null
  last_checked_at: Date | null
  detected_os: DetectedOs | null
  os_probe_state: string
  observed_config_revision: string
  environment_revision: string
  os_checked_at: Date | null
  os_error: unknown
  cpu_cores: number | null
  cpu_percent: number | string | null
  mem_total_bytes: string | null
  mem_used_bytes: string | null
  disk_total_bytes: string | null
  disk_used_bytes: string | null
  metrics_at: Date | null
}

export interface SoftwareFact {
  server_id: string
  software_key: string
  probe_state: string
  checked_at: Date
  recipe_key: string
  recipe_revision: string
  observed_config_revision: string
  observed_environment_revision: string
  product_version: string | null
  healthy: boolean | null
  error: { detail?: string } | null
}

export interface ActiveOperation {
  id: string
  server_id: string
  state: string
  phase: string
  mutation_phase: string | null
  lease_expires_at: Date | null
  result: { remote_state?: string; remote_checked_at?: string } | null
}

export interface ServerPatch {
  name?: string
  host?: string
  ssh_port?: number
  ssh_user?: string
  region?: string
  type_key?: string
  type_snapshot?: string
  type_revision?: string
  install_required_software?: boolean
  declared_os?: string
  group_id?: string | null
  auth_method?: string
  ssh_key_id?: string | null
  secret_ciphertext?: string | null
  config_revision?: string | number
}
