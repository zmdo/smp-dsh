export type JobPurpose = 'inspect' | 'apply_plan' | 'detect_updates'

export interface JobRequest {
  action: string
  prepare?: boolean
  automatic?: boolean
  intervalSeconds?: number
  planId?: string
  digest?: string
}

export const LEASE_SECONDS = 60
