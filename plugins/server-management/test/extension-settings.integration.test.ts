import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import type { Db } from '../src/host/database/connection.ts'
import { extensionSettings, saveExtensionSettings } from '../src/host/extensions/settings.ts'
import { applyExtensionSettingsPlan, planExtensionSettings } from '../src/host/extensions/settings-plan.ts'

test(
  'extension settings use revisioned conditional writes',
  { skip: !process.env.SMP_TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const admin = new Pool({ connectionString: process.env.SMP_TEST_DATABASE_URL })
    const schema = `extension_settings_${randomUUID().replaceAll('-', '')}`
    await admin.query(`create schema ${schema}`)
    const pool = new Pool({
      connectionString: process.env.SMP_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    })
    const db = pool as unknown as Db
    try {
      for (const name of [
        '0010_server_management.sql',
        '0012_server_types.sql',
        '0013_server_observations.sql',
        '0014_server_execution.sql',
        '0015_server_inspection_reports.sql',
        '0016_server_version_policies.sql',
        '0017_server_extension_settings.sql',
        '0018_server_extension_setting_plans.sql',
      ])
        await pool.query(await readFile(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8'))
      const serverId = randomUUID()
      await pool.query(
        `insert into servers(id,name,host,ssh_port,ssh_user,auth_method,secret_ciphertext,region,type_key,type_snapshot,type_revision,declared_os)
         values($1,$2,$3,22,'test','password','cipher','','builtin/vacant','{}','','{"kind":"custom","text":"test"}')`,
        [serverId, 'test', `host-${serverId}`],
      )
      assert.equal(await extensionSettings(db, serverId, '@test/ext', 'database-settings'), undefined)
      const first = await saveExtensionSettings(db, {
        serverId,
        owner: '@test/ext',
        section: 'database-settings',
        value: { collect: true },
        expectedRevision: '0',
      })
      assert.equal(first?.revision, '1')
      const second = await saveExtensionSettings(db, {
        serverId,
        owner: '@test/ext',
        section: 'database-settings',
        value: { collect: false },
        expectedRevision: '1',
      })
      assert.equal(second?.revision, '2')
      assert.equal(
        await saveExtensionSettings(db, {
          serverId,
          owner: '@test/ext',
          section: 'database-settings',
          value: { collect: true },
          expectedRevision: '1',
        }),
        undefined,
      )
      assert.deepEqual((await extensionSettings(db, serverId, '@test/ext', 'database-settings'))?.value, {
        collect: false,
      })
      const plan = await planExtensionSettings(db, {
        serverId,
        owner: '@test/ext',
        section: 'database-settings',
        value: { collect: true },
        expectedRevision: '2',
      })
      const applied = await applyExtensionSettingsPlan(db, {
        serverId,
        owner: '@test/ext',
        section: 'database-settings',
        planId: plan.id,
        digest: plan.digest,
      })
      assert.equal(applied.revision, '3')
      await assert.rejects(
        applyExtensionSettingsPlan(db, {
          serverId,
          owner: '@test/ext',
          section: 'database-settings',
          planId: plan.id,
          digest: plan.digest,
        }),
        { code: 'extension_plan_not_pending' },
      )
      await assert.rejects(
        planExtensionSettings(db, {
          serverId,
          owner: '@test/ext',
          section: 'database-settings',
          value: { collect: false },
          expectedRevision: '2',
        }),
        { code: 'extension_settings_conflict' },
      )
    } finally {
      await pool.end()
      await admin.query(`drop schema ${schema} cascade`)
      await admin.end()
    }
  },
)
