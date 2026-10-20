import { type Component } from '../catalog.ts'
import type { DefinitionRegistry } from '../registry.ts'
import { type Db } from './db.ts'
import { type Enrollment } from './servers/enrollment.ts'

interface Secrets {
  encrypt(secret: string): string
  decrypt(ciphertext: string): string
}
export interface Deps {
  db: Db
  secrets: Secrets
  catalog: readonly Component[]
  definitions: DefinitionRegistry
  enrollment: Enrollment
  freshnessMs?: number
  updateCheckIntervalSeconds?: number
}
