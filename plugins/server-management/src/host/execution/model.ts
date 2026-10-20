export interface JobRecord {
  id: string
  server_id: string
  server_identity: string
  purpose: 'inspect' | 'apply_plan' | 'detect_updates'
  state: string
  phase: string
  mutation_phase: string | null
  expected_config_revision: string
  expected_environment_revision: string
  definition_revision: string
  target_id: string | null
  operation_id: string
  worker_id: string
  fence: string
  lease_expires_at: Date
  request_snapshot: {
    action: string
    prepare?: boolean
    automatic?: boolean
    intervalSeconds?: number
    planId?: string
    digest?: string
  }
  result: unknown
  output_excerpt: string
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

export const LEASE_SECONDS = 60
