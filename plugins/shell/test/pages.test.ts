import assert from 'node:assert/strict'
import test from 'node:test'
import { navGroups, pageLabel, pageRoutes } from '../src/pages.ts'
import { shellCopy } from '../src/copy.ts'
import { checkNewPassword, cleanUsername } from '../src/security.ts'
import { newSecret, provisioningUri } from '../src/totp.ts'
import { decryptMnemonic, encryptMnemonic } from '../src/vault.ts'

test('harness settings sits with login security under platform settings', () => {
  const routes = pageRoutes([
    { options: { key: 'settings', label: pageLabel('登录安全', { group: 'platform', groupLabel: '平台设置', placement: 'footer' }), order: 5 } },
    { options: { key: 'general', label: pageLabel('通用', { group: 'platform', groupLabel: '平台设置', placement: 'footer' }), order: 0 } },
    { options: { key: 'harness', label: pageLabel('Harness 设置', { group: 'platform', groupLabel: '平台设置', placement: 'footer' }), order: 10 } },
    { options: { key: 'markets', label: '行情', order: 30 } },
  ])
  const groups = navGroups(routes)
  assert.deepEqual(groups.nav.map(group => group.label), ['行情'])
  assert.deepEqual(groups.footer[0]?.pages.map(page => page.label), ['通用', '登录安全', 'Harness 设置'])
})

test('sidebar routes follow the pages plugins registered', () => {
  const routes = pageRoutes([
    { options: { key: 'servers', label: '服务器', order: 20 } },
    { options: { key: 'settings', label: pageLabel('登录安全', { group: 'platform', groupLabel: '平台设置', placement: 'footer' }), order: 0 } },
    { options: { key: 'mcp', label: pageLabel('MCP', { group: 'platform', groupLabel: '平台设置', placement: 'footer' }), order: 10 } },
    { options: { key: 'markets', label: '行情', order: 30 } },
    { options: { key: 'hidden' } },
  ])
  const groups = navGroups(routes)
  assert.deepEqual(groups.nav.map(group => group.label), ['服务器', '行情'])
  assert.deepEqual(groups.footer.map(group => group.label), ['平台设置'])
  assert.deepEqual(groups.footer[0]?.pages.map(page => page.label), ['登录安全', 'MCP'])
})

test('shell labels are read again when the locale changes', () => {
  let active = 'zh'
  const page = {
    options: {
      key: 'settings',
      label: pageLabel(() => shellCopy(active).security, {
        group: 'platform',
        groupLabel: () => shellCopy(active).platform,
        placement: 'footer' as const,
      }),
      order: 0,
    },
  }
  assert.equal(pageRoutes([page])[0]?.label, '安全')
  active = 'en'
  const next = pageRoutes([page])
  assert.equal(next[0]?.label, 'Security')
  assert.equal(navGroups(next).footer[0]?.label, 'Platform settings')
})

test('a username with a space is rejected', () => {
  assert.equal(cleanUsername('  admin  ').body?.username, 'admin')
  assert.equal(cleanUsername('a b').ok, false)
  assert.equal(cleanUsername('   ').ok, false)
})

test('a new password must differ and stay within the bcrypt limit', () => {
  assert.equal(checkNewPassword('old', 'old').ok, false)
  assert.equal(checkNewPassword('old', 'x'.repeat(73)).ok, false)
  assert.equal(checkNewPassword('old', 'newer').ok, true)
})

test('a new authenticator secret is a provisioning uri', () => {
  const secret = newSecret()
  assert.equal(secret.length, 32)
  assert.equal(
    provisioningUri('JBSWY3DPEHPK3PXP', 'admin'),
    'otpauth://totp/%E7%AD%96%E7%95%A5%E6%8E%A7%E5%88%B6%E5%8F%B0%3Aadmin?secret=JBSWY3DPEHPK3PXP&issuer=%E7%AD%96%E7%95%A5%E6%8E%A7%E5%88%B6%E5%8F%B0',
  )
})

test('a wallet mnemonic round-trips through the password vault', async () => {
  const stored = await encryptMnemonic('secret', 'abandon abandon abandon')
  assert.equal(await decryptMnemonic('secret', stored), 'abandon abandon abandon')
  await assert.rejects(() => decryptMnemonic('other', stored))
})
