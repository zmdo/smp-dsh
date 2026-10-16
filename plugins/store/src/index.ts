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
  private readonly codec: SecretsCodec

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

export function apply(ctx: Context, config: Config): void {
  const key = decodeFernetKey(config.encryptionKey)
  const connectionString = normalizeDatabaseUrl(config.databaseUrl)
  const codec = new SecretsCodec(key)
  ctx.effect(async function* () {
    const pool = new Pool({ connectionString })
    yield () => pool.end()
    await applyMigrations(pool, migrationsDir)
    new Database(ctx, pool)
    new Secrets(ctx, codec)
  })
}
