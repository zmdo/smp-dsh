import { type Db } from '../db.ts'

export function findKey(db: Db, id: string) {
  return db.query('select id from ssh_keys where id = $1', [id])
}

export function listKeys(db: Db) {
  return db.query(
    `select k.id, k.name, k.fingerprint, k.created_at, (select count(*)::int from servers s where s.ssh_key_id = k.id) as server_count from ssh_keys k order by k.name`,
  )
}

export function insertKey(
  db: Db,
  {
    id,
    name,
    fingerprint,
    ciphertext,
  }: { id: string; name: string; fingerprint: string; ciphertext: string },
) {
  return db.query(
    'insert into ssh_keys (id, name, fingerprint, secret_ciphertext) values ($1, $2, $3, $4) returning id, name, fingerprint, created_at',
    [id, name, fingerprint, ciphertext],
  )
}

export function referenceCount(db: Db, id: string) {
  return db.query<{ count: number }>('select count(*)::int as count from servers where ssh_key_id = $1', [id])
}

export function deleteKey(db: Db, id: string) {
  return db.query('delete from ssh_keys where id = $1 returning id', [id])
}

export function secretForConnection(db: Db, id: string) {
  return db.query<{ secret_ciphertext: string }>('select secret_ciphertext from ssh_keys where id=$1', [id])
}
