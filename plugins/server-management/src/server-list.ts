import {policySignature} from './policies.ts'
import type { SoftwarePolicy } from './policies.ts'
import { typeSupportsOs, type GroupRecord, type ServerTypeView, type LocalizedText } from './definitions.ts'
import { DefinitionRegistry } from './registry.ts'
import { osLabel, osVerification, type DeclaredOs, type DetectedOs } from './operating-systems.ts'
import { ServerError } from './i18n.ts'
import { HttpError, type Db } from './store.ts'
import { SERVER_STATES, type DisplayStatus, type ServerDisplayStatus, type ServerListItem, type ServerListPage, type StatusReason } from './server-list-contract.ts'

interface ServerFact {
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
export interface ServerListQuery {
  groupId: string | null
  query: string
  status: ServerDisplayStatus | ''
  order: 'name' | 'last_checked'
  page: number
  pageSize: number
  needsUpgrade?: boolean
}
export function parseServerListQuery(params: URLSearchParams): ServerListQuery {
  const group = params.get('group_id')
  const groupId = group === null ? null : group === 'ungrouped' ? '' : group
  const query = (params.get('q') ?? '').trim()
  const status = params.get('status') ?? ''
  const order = params.get('order') ?? 'name'
  if ((groupId !== null && groupId !== '' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId))
    || query.length > 200 || (status && !SERVER_STATES.some(value => value === status)) || (order !== 'name' && order !== 'last_checked'))
    throw new HttpError(422, 'server_query_invalid')
  function integer(key: string, fallback: number, maximum: number) {
    const value = params.get(key)
    if (value === null) return fallback
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new HttpError(422, 'server_query_invalid')
    return Number(value)
  }
  return { needsUpgrade: params.get('needs_upgrade')==='true', groupId, query, status: status as ServerListQuery['status'], order, page: integer('page', 1, 1_000_000), pageSize: integer('page_size', 10, 100) }
}

function recent(date: Date | null, now: number, maxAge: number): boolean {
  return date !== null && date.getTime() <= now && now - date.getTime() <= maxAge
}
function reason(code: StatusReason['code'], parameters: Record<string, string> = {}): StatusReason { return { code, parameters } }

export function displayStatus(input: {
  row: Pick<ServerFact, 'reachability' | 'connection_error' | 'last_checked_at' | 'os_checked_at'>
  verification: string
  available: boolean
  compatible: boolean
  software: readonly { key: string; name?: LocalizedText; state: string; healthy: boolean | null; compliant: boolean }[]
  operation?: ActiveOperation
  now: number
  maxAge: number
}): DisplayStatus {
  const { row, operation, now, maxAge } = input
  const attention: StatusReason[] = [], unverified: StatusReason[] = []
  if (!input.available) attention.push(reason('type_unavailable'))
  else if (!input.compatible) attention.push(reason('os_unsupported'))
  if (input.verification === 'mismatch') attention.push(reason('os_mismatch'))
  else if (input.verification !== 'matched' || !recent(row.os_checked_at, now, maxAge)) unverified.push(reason('os_unverified'))
  for (const software of input.software) {
    const parameters = { software: software.key, softwareZh: software.name?.zh ?? software.key, softwareEn: software.name?.en ?? software.key }
    if (software.state === 'missing') attention.push(reason('software_missing', parameters))
    else if (software.state !== 'installed') unverified.push(reason('software_unknown', parameters))
    else if (software.healthy === false) attention.push(reason('software_unhealthy', parameters))
    else if (!software.compliant) attention.push(reason('software_version', parameters))
    else if (software.healthy !== true) unverified.push(reason('software_unknown', parameters))
  }
  if (row.reachability === 'offline') attention.unshift(reason('connection_failed', { detail: row.connection_error?.message ?? '' }))
  else if (row.reachability !== 'online') unverified.unshift(reason('connection_unknown'))
  else if (!recent(row.last_checked_at, now, maxAge)) unverified.unshift(reason('connection_stale'))
  const reasons = [...attention, ...unverified]
  const result = (code: ServerDisplayStatus, extra: StatusReason[] = [], jobId: string | null = null): DisplayStatus => ({ code, reasons: [...extra, ...reasons], jobId })
  if (operation?.mutation_phase) {
    const owned = operation.lease_expires_at !== null && operation.lease_expires_at.getTime() > now
    const remoteKnown = operation.result?.remote_state === 'running' && recent(
      operation.result.remote_checked_at ? new Date(operation.result.remote_checked_at) : null, now, maxAge,
    )
    if (!owned) return result('attention', [reason('operation_expired')], operation.id)
    if (operation.state === 'recovering' && !remoteKnown) return result('attention', [reason('operation_recovering')], operation.id)
    if (operation.state === 'running' || (operation.state === 'recovering' && remoteKnown))
      return result(operation.mutation_phase === 'upgrading' ? 'upgrading' : 'installing', [reason('operation_running')], operation.id)
  }
  if (row.reachability === 'offline') return result('disconnected')
  if (attention.length) return result('attention')
  if (unverified.length) return result('unverified')
  return result('normal')
}

interface ReadDeps { db: Db; definitions: DefinitionRegistry; freshnessMs?: number }

async function readSnapshot<T>(deps: ReadDeps, query: ServerListQuery | { id: string }, project: (data: {
  rows: ReturnType<typeof enrich>[]; groups: import('./definitions.ts').GroupView[]; counts: { all: number; ungrouped: number }; groupId: string | null; now: number
}) => T): Promise<T> {
  const client = await deps.db.connect()
  try {
    await client.query('begin isolation level repeatable read read only')
    const now = (await client.query<{ now: Date }>('select now() as now')).rows[0]!.now.getTime()
    const groups = (await client.query<GroupRecord>(`select g.*,(select count(*)::int from servers s where s.group_id=g.id) as server_count
      from server_groups g order by sort_order,created_at,id`)).rows
    const counts = (await client.query<{ all: number; ungrouped: number }>(`select count(*)::int as all,count(*) filter(where group_id is null)::int as ungrouped from servers`)).rows[0]!
    const groupId = 'groupId' in query && query.groupId && !groups.some(group => group.id === query.groupId) ? null : 'groupId' in query ? query.groupId : null
    const records = (await client.query<ServerFact>(`select s.id,s.name,s.host,s.ssh_port,s.ssh_user,s.auth_method,s.ssh_key_id,s.group_id,
      s.region,s.install_required_software,s.type_key,s.type_snapshot,s.type_revision,s.config_revision,s.declared_os,s.host_fingerprint,s.created_at,
      r.connection_state as reachability,r.connection_error,r.connection_checked_at as last_checked_at,
      r.detected_os,r.os_probe_state,r.observed_config_revision,r.environment_revision,r.os_checked_at,r.os_error,
      r.cpu_cores,r.cpu_percent,r.memory_total_bytes as mem_total_bytes,r.memory_used_bytes as mem_used_bytes,r.disk_total_bytes,r.disk_used_bytes,r.metrics_sampled_at as metrics_at
      from servers s join server_runtime r on r.server_id=s.id
      where ($1::uuid is null or s.id=$1) and ($2::boolean or s.group_id is not distinct from $3::uuid)`,
      ['id' in query ? query.id : null, groupId === null, groupId || null])).rows
    const ids = records.map(row => row.id)
    const observations = (await client.query<SoftwareFact>('select * from server_software_observations where server_id=any($1::uuid[])', [ids])).rows
    const operations = (await client.query<ActiveOperation>(`select id,server_id,state,phase,mutation_phase,lease_expires_at,result from server_jobs
      where server_id=any($1::uuid[]) and state in ('claimed','running','recovering')`, [ids])).rows
    const policies=(await client.query<SoftwarePolicy & {server_id:string}>('select server_id,software_key,restriction,detect_updates from server_software_policies where server_id=any($1::uuid[])',[ids])).rows
    const upgrades=(await client.query<{server_id:string;count:number;definition:string}>(`select u.server_id,u.basis_snapshot->>'definitionRevision' as definition,count(*)::int as count from server_upgrade_suggestions u join servers s on s.id=u.server_id join server_runtime r on r.server_id=s.id where u.server_id=any($1::uuid[]) and u.validity='eligible' and u.decision='none' and u.basis_snapshot->>'configRevision'=s.config_revision::text and u.basis_snapshot->>'environmentRevision'=r.environment_revision::text group by u.server_id,u.basis_snapshot->>'definitionRevision'`,[ids])).rows
    const byServer = new Map<string, Map<string, SoftwareFact>>()
    for (const observation of observations) {
      if (!byServer.has(observation.server_id)) byServer.set(observation.server_id, new Map())
      byServer.get(observation.server_id)!.set(observation.software_key, observation)
    }
    const byOperation = new Map(operations.map(operation => [operation.server_id, operation]))
    const byGroup = new Map(groups.map(group => [group.id, group]))
    // No await while resolving definitions, deriving status and filtering the entire candidate set.
    const rows = records.map(row => enrich(row, row.group_id ? byGroup.get(row.group_id)! : null,
      byServer.get(row.id), byOperation.get(row.id), deps.definitions, now, deps.freshnessMs ?? 90_000,policies.filter(p=>p.server_id===row.id),upgrades.filter(u=>u.server_id===row.id)))
    const result = project({ rows, groups: groups.map(group => deps.definitions.view(group)), counts, groupId, now })
    await client.query('commit')
    return result
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally { client.release() }
}

function enrich(row: ServerFact, group: GroupRecord | null, observations: Map<string, SoftwareFact> | undefined,
  operation: ActiveOperation | undefined, definitions: DefinitionRegistry, now: number, maxAge: number, policies:SoftwarePolicy[],upgradeCounts:{count:number;definition:string}[]) {
  const osState = String(row.observed_config_revision) === String(row.config_revision) ? row.os_probe_state : 'unknown'
  const verification = osVerification(row.declared_os, row.detected_os, osState)
  let resolved: ReturnType<DefinitionRegistry['describeType']>
  try { resolved = definitions.describeType(group, row.type_key, verification === 'matched' && row.detected_os ? row.detected_os : row.declared_os) }
  catch (cause) { if (!(cause instanceof ServerError)) throw cause }
  const type = resolved?.type ?? row.type_snapshot
  const available = resolved !== undefined
  const upgradeCount=resolved?upgradeCounts.filter(u=>u.definition===policySignature(resolved.signature,policies)).reduce((n,u)=>n+u.count,0):0
  const required = type.software.map(item=>{
    const component=resolved?.components.find(c=>c.software_key===item.software_key),policy=policies.find(p=>p.software_key===item.software_key)
    return {...item,versions:component&&policy?component.adapter.intersect([component.versions,policy.restriction])??component.versions:item.versions}
  })
  const components = new Map((resolved?.components ?? []).map(component => [component.software_key, component]))
  const software_status: Record<string, { state: string; installed: boolean; version?: string; last_known_version?: string | null; detail?: string; revision?: string }> = {}
  const software = required.map(item => {
    const fact = observations?.get(item.software_key)
    const fresh = fact && fact.recipe_revision === item.revision && fact.recipe_key === item.recipe
      && String(fact.observed_config_revision) === String(row.config_revision)
      && String(fact.observed_environment_revision) === String(row.environment_revision) && recent(fact.checked_at, now, maxAge)
    const state = fresh ? fact.probe_state : 'unknown'
    const component = components.get(item.software_key)
    let compliant = false
    if (state === 'installed' && fact?.product_version && component) {
      try { compliant = component.adapter.contains(required.find(s=>s.software_key===item.software_key)?.versions??component.versions, fact.product_version) }
      catch (cause) { if (!(cause instanceof ServerError)) throw cause }
    }
    software_status[item.id] = { state, installed: state === 'installed', version: state === 'installed' ? fact?.product_version ?? undefined : undefined,
      last_known_version: fact?.product_version, detail: fact?.error?.detail, revision: fact?.recipe_revision }
    return { key: item.software_key, name: item.name_i18n, state, healthy: fresh ? fact.healthy : null, compliant }
  })
  const compatible = typeSupportsOs(type, verification === 'matched' && row.detected_os ? row.detected_os : row.declared_os)
  const status = displayStatus({ row, verification, available, compatible, software, operation, now, maxAge })
  const installation = { enabled: row.install_required_software,
    applicability: !available ? 'unavailable' as const : required.length ? 'applicable' as const : 'not-applicable' as const }
  const softwareState = !available ? 'unavailable' : software.some(item => item.state === 'missing') ? 'pending'
    : software.every(item => item.state === 'installed' && item.healthy === true && item.compliant) ? 'ready' : 'unknown'
  return { ...row, upgrade_count:upgradeCount, software_policies:policies, group_name: group?.name ?? null, group_name_i18n: group?.name_i18n ?? null,
    software_status, os_verification: verification, type_supported_os: type.supportedOs, type_os_compatible: compatible,
    docker_version: observations?.get('builtin/docker-engine')?.product_version ?? null,
    compose_version: observations?.get('builtin/docker-compose')?.product_version ?? null,
    type_name_i18n: type.name_i18n, type_available: available, required_software: required, software_state: softwareState,
    status, installation, resources_fresh: recent(row.metrics_at, now, maxAge) }
}

function listItem(row: ReturnType<typeof enrich>): ServerListItem {
  return { id: row.id, name: row.name, upgradeCount:row.upgrade_count, address: { host: row.host, port: row.ssh_port },
    operatingSystem: { declared: row.declared_os, label: osLabel(row.declared_os), verification: row.os_verification },
    type: { key: row.type_key, name: row.type_name_i18n, available: row.type_available }, status: row.status,
    installRequiredSoftware: row.installation,
    resources: { cpuPercent: row.cpu_percent === null ? null : Number(row.cpu_percent), memoryUsed: row.mem_used_bytes,
      memoryTotal: row.mem_total_bytes, diskUsed: row.disk_used_bytes, diskTotal: row.disk_total_bytes,
      sampledAt: row.metrics_at?.toISOString() ?? null, fresh: row.resources_fresh }, lastCheckedAt: row.last_checked_at?.toISOString() ?? null }
}

export async function serverList(deps: ReadDeps, query: ServerListQuery): Promise<ServerListPage> {
  return readSnapshot(deps, query, ({ rows, groups, counts, groupId }) => {
    const needle = query.query.toLocaleLowerCase()
    const selected = rows.filter(row => (!query.needsUpgrade||row.upgrade_count>0) && (!query.status || row.status.code === query.status)
      && (!needle || [row.name, row.host, `${row.host}:${row.ssh_port}`, row.ssh_user, row.region,
        row.group_name ?? '', row.group_name_i18n?.zh ?? '', row.group_name_i18n?.en ?? '', row.type_key,
        row.type_name_i18n.zh, row.type_name_i18n.en, osLabel(row.declared_os),
        row.declared_os.kind === 'catalog' ? row.declared_os.family : ''].some(value => value.toLocaleLowerCase().includes(needle))))
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
    selected.sort((a, b) => (query.order === 'last_checked' ? (b.last_checked_at?.getTime() ?? -Infinity) - (a.last_checked_at?.getTime() ?? -Infinity) : 0)
      || compare(a.name, b.name) || compare(a.id, b.id))
    const page = Math.max(1, Math.min(query.page, Math.ceil(selected.length / query.pageSize)))
    return { items: selected.slice((page - 1) * query.pageSize, page * query.pageSize).map(listItem), total: selected.length,
      page, page_size: query.pageSize, group_id: groupId,
      groups: groups.map(group => ({ id: group.id, name: group.name, name_i18n: group.name_i18n, kind: group.kind,
        plugin_id: group.plugin_id, available: group.available, server_count: group.server_count ?? 0 })), counts }
  })
}

export async function serverRead(deps: ReadDeps, id: string) {
  return readSnapshot(deps, { id }, ({ rows }) => rows[0])
}
