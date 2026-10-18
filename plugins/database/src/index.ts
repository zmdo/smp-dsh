import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { decodeFernetKey, SecretsCodec } from './fernet.ts'
import { applyMigrations } from './migrate.ts'
import { normalizeDatabaseUrl } from './url.ts'

/** Queries go through this pool. Callers do not open their own. */
export class Database extends Service {
  readonly pool: Pool

  constructor(ctx: Context, pool: Pool) {
    super(ctx, 'database')
    this.pool = pool
  }
}

/** Ciphertext stored in PostgreSQL. The key stays in this service. */
export class Secrets extends Service {
  private codec: SecretsCodec

  constructor(ctx: Context, codec: SecretsCodec) {
    super(ctx, 'secrets')
    this.codec = codec
  }

  encrypt(plaintext: string): string {
    return this.codec.encrypt(plaintext)
  }

  decrypt(ciphertext: string): string {
    return this.codec.decrypt(ciphertext)
  }

  /** Later writes use this key. Text already stored with the previous key cannot be opened. */
  replaceKey(encoded: string): void {
    this.codec = new SecretsCodec(decodeFernetKey(encoded))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    database: Database
    secrets: Secrets
  }
}

export interface Config {
  databaseUrl: string
  encryptionKey: string
}

export const Config: Schema<Config> = Schema.object({
  databaseUrl: String,
  encryptionKey: String,
})

export const inject = []

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))

// How long a startup connection may wait before the plugin fails to load.
const CONNECT_TIMEOUT_MS = 5_000

/**
 * The returned generator is the plugin's own effect. A nested effect would
 * only log a failed connection, and dependents would wait for a service that
 * never appears.
 */
export async function* apply(ctx: Context, config: Config): AsyncGenerator<() => Promise<void>> {
  const key = decodeFernetKey(config.encryptionKey)
  const connectionString = normalizeDatabaseUrl(config.databaseUrl)
  const codec = new SecretsCodec(key)
  const pool = new Pool({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  pool.on('error', (error: Error) => {
    ctx.logger.error(error)
  })
  yield () => pool.end()
  await applyMigrations(pool, migrationsDir)
  new Database(ctx, pool)
  new Secrets(ctx, codec)
}
