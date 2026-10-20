import type { Db } from '../database/connection.ts'
import type { Json } from '../../shared/contracts/common.ts'
import { readSettings, saveSettings, type StoredExtensionSettings } from './persistence/settings-repository.ts'

export async function extensionSettings(
  db: Db,
  serverId: string,
  owner: string,
  section: string,
): Promise<StoredExtensionSettings | undefined> {
  return (await readSettings(db, serverId, owner, section)).rows[0]
}

export async function saveExtensionSettings(
  db: Db,
  input: { serverId: string; owner: string; section: string; value: Json; expectedRevision: string },
): Promise<StoredExtensionSettings | undefined> {
  return (await saveSettings(db, input)).rows[0]
}
