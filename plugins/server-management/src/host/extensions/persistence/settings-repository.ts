import type { Db } from '../../database/connection.ts'
import type { Json } from '../../../shared/contracts/common.ts'

export interface StoredExtensionSettings {
  value: Json
  revision: string
}

export function readSettings(db: Db, serverId: string, owner: string, section: string) {
  return db.query<StoredExtensionSettings>(
    'select value, revision::text from server_extension_settings where server_id=$1 and owner=$2 and section_key=$3',
    [serverId, owner, section],
  )
}

/** Expected revision 0 inserts; a changed revision updates only the matching row. */
export function saveSettings(
  db: Db,
  input: { serverId: string; owner: string; section: string; value: Json; expectedRevision: string },
) {
  return db.query<StoredExtensionSettings>(
    `insert into server_extension_settings(server_id,owner,section_key,value,revision)
     values($1,$2,$3,$4,1)
     on conflict(server_id,owner,section_key) do update
       set value=excluded.value, revision=server_extension_settings.revision+1, updated_at=now()
       where server_extension_settings.revision=$5
     returning value, revision::text`,
    [input.serverId, input.owner, input.section, JSON.stringify(input.value), input.expectedRevision],
  )
}
