import { type Db } from '../db.ts'
import { type EditableServer, type ServerPatch } from './model.ts'

export function containers(db: Db, id: string) {
  return db.query(
    'select container_id, name, image, status, ports, managed, strategy_slug, observed_at from server_containers where server_id = $1 order by name',
    [id],
  )
}

export function containerScan(db: Db, id: string) {
  return db.query<{ state: string; last_success_at: Date | null }>(
    'select state,last_success_at from server_container_scans where server_id=$1',
    [id],
  )
}

export function policies(db: Db, id: string) {
  return db.query('select * from server_software_policies where server_id=$1 order by software_key', [id])
}

export function insertServer(
  db: Db,
  {
    id,
    name,
    host,
    port,
    user,
    method,
    ciphertext,
    keyId,
    groupId,
    region,
    auto,
    os,
    typeKey,
    typeSnapshot,
    typeRevision,
  }: {
    id: string
    name: string
    host: string
    port: number
    user: string
    method: string
    ciphertext: string | null
    keyId: string | null
    groupId: string | null
    region: string
    auto: boolean
    os: string
    typeKey: string
    typeSnapshot: string
    typeRevision: string
  },
) {
  return db.query(
    `insert into servers (id, name, host, ssh_port, ssh_user, auth_method, secret_ciphertext, ssh_key_id, group_id, region,
          install_required_software, declared_os, type_key, type_snapshot, type_revision)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      name,
      host,
      port,
      user,
      method,
      ciphertext,
      keyId,
      groupId,
      region,
      auto,
      os,
      typeKey,
      typeSnapshot,
      typeRevision,
    ],
  )
}

export function insertRuntime(db: Db, id: string) {
  return db.query('insert into server_runtime(server_id) values ($1)', [id])
}

export function lockEditable(db: Db, id: string) {
  return db.query<EditableServer>(
    'select id, host, ssh_port, ssh_user, auth_method, ssh_key_id, install_required_software, declared_os, group_id, type_key, type_snapshot, type_revision, config_revision from servers where id = $1 for update',
    [id],
  )
}

export function obsoleteSuggestions(db: Db, id: string) {
  return db.query(
    "update server_upgrade_suggestions set validity='obsolete' where server_id=$1 and validity in ('eligible','blocked')",
    [id],
  )
}

export function resetConnection(db: Db, id: string) {
  return db.query(
    "update server_runtime set connection_state='unknown', connection_error=null, connection_checked_at=null where server_id=$1",
    [id],
  )
}

export function activeJobs(db: Db, id: string) {
  return db.query(
    "select id from server_jobs where server_id = $1 and state in ('claimed','running','recovering') limit 1",
    [id],
  )
}

export function lockBinding(db: Db, id: string) {
  return db.query<Pick<EditableServer, 'id' | 'group_id' | 'type_key' | 'config_revision' | 'declared_os'>>(
    'select id, group_id, type_key, config_revision, declared_os from servers where id = $1 for update',
    [id],
  )
}

export function lockServer(db: Db, id: string) {
  return db.query('select id from servers where id=$1 for update', [id])
}

export function cancelQueuedJobs(db: Db, id: string) {
  return db.query(
    "update server_jobs set state='cancelled',finished_at=now() where server_id=$1 and state='queued'",
    [id],
  )
}

export function cancelPendingPlans(db: Db, id: string) {
  return db.query(
    "update server_change_plans p set state='cancelled' from server_change_targets t where p.id=t.plan_id and t.server_id=$1 and t.state='pending'",
    [id],
  )
}

export function cancelPendingTargets(db: Db, id: string) {
  return db.query(
    "update server_change_targets set state='cancelled',finished_at=now() where server_id=$1 and state='pending'",
    [id],
  )
}

export function deleteServer(db: Db, id: string) {
  return db.query('delete from servers where id=$1', [id])
}

export function findServer(db: Db, id: string) {
  return db.query('select id from servers where id = $1', [id])
}

export function updateServer(db: Db, id: string, patch: ServerPatch) {
  const params: unknown[] = [id]
  const sets = Object.entries(patch).map(([column, value]) => {
    params.push(value)
    return `${column} = $${params.length}`
  })
  return db.query(`update servers set ${sets.join(', ')}, updated_at = now() where id = $1`, params)
}
