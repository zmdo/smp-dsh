export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  connect(): Promise<DbClient>
}

export interface DbClient extends Db {
  release(): void
}

export async function transaction<T>(db: Db, run: (client: DbClient) => Promise<T>): Promise<T> {
  return inTransaction(db, 'begin', run)
}
export async function readTransaction<T>(db: Db, run: (client: DbClient) => Promise<T>): Promise<T> {
  return inTransaction(db, 'begin isolation level repeatable read read only', run)
}
async function inTransaction<T>(db: Db, begin: string, run: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query(begin)
    const result = await run(client)
    await client.query('commit')
    return result
  } catch (cause) {
    await client.query('rollback')
    throw cause
  } finally {
    client.release()
  }
}
export function lockCatalog(db: Db) {
  return db.query("select pg_advisory_xact_lock(hashtextextended('smp/server-management/catalog', 0))")
}
export function isUnique(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505'
}
