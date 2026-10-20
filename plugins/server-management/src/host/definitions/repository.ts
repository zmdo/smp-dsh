import { type GroupRecord } from '../../shared/definitions.ts'
import type { Db } from '../db.ts'

export function upsertSystemGroup(
  db: Db,
  {
    id,
    name,
    owner,
    groupKey,
    nameI18n,
    order,
    definition,
  }: {
    id: string
    name: string
    owner: string
    groupKey: string
    nameI18n: string
    order: number
    definition: string
  },
) {
  return db.query<{ id: string }>(
    `insert into server_groups(id,name,kind,plugin_id,group_key,name_i18n,sort_order,definition)
          values($1,$2,'system',$3,$4,$5,$6,$7) on conflict(plugin_id,group_key) where kind='system'
          do update set name=excluded.name,name_i18n=excluded.name_i18n,sort_order=excluded.sort_order,definition=excluded.definition returning id`,
    [id, name, owner, groupKey, nameI18n, order, definition],
  )
}

export function readGroup(db: Db, id: string) {
  return db.query<GroupRecord>('select * from server_groups where id=$1', [id])
}
