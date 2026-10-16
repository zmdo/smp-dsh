import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import QRCode from 'qrcode'

interface AuthSnap {
  username: string | null
  totpEnabled: boolean
}

interface AuthStore {
  get(): AuthSnap
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
}

async function post(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { detail?: unknown }
  if (!response.ok) {
    throw new Error(typeof payload.detail === 'string' ? payload.detail : '请求失败')
  }
  return payload as Record<string, unknown>
}

/** Login security, registered by the shell itself. */
export function SecurityView(props: { auth: AuthStore }) {
  const auth = useSyncExternalStore(props.auth.subscribe, props.auth.get)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [disablePassword, setDisablePassword] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [username, setUsername] = useState(auth.username ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (auth.username !== null) setUsername(auth.username)
  }, [auth.username])

  async function run(action: () => Promise<string>): Promise<void> {
    setError('')
    setMessage('')
    setBusy(true)
    try {
      setMessage(await action())
      await props.auth.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '请求失败')
    } finally {
      setBusy(false)
    }
  }

  function saveUsername(event: FormEvent): void {
    event.preventDefault()
    void run(async () => {
      await post('/console-api/auth/username', { username })
      return '用户名已修改'
    })
  }

  function beginSetup(): void {
    void run(async () => {
      const created = await post('/console-api/auth/totp/setup')
      const secret = String(created.secret ?? '')
      const otpauthUri = String(created.otpauth_uri ?? '')
      setQrDataUrl(await QRCode.toDataURL(otpauthUri, { margin: 1, width: 196 }))
      setSetup({ secret, otpauth_uri: otpauthUri })
      return ''
    })
  }

  function confirmSetup(event: FormEvent): void {
    event.preventDefault()
    void run(async () => {
      await post('/console-api/auth/totp/confirm', { code: confirmCode })
      setSetup(null)
      setQrDataUrl('')
      setConfirmCode('')
      return '两步验证已开启'
    })
  }

  function disable(event: FormEvent): void {
    event.preventDefault()
    void run(async () => {
      await post('/console-api/auth/totp/disable', { password: disablePassword, code: disableCode })
      setDisablePassword('')
      setDisableCode('')
      return '两步验证已关闭'
    })
  }

  function changePassword(event: FormEvent): void {
    event.preventDefault()
    void run(async () => {
      await post('/console-api/auth/password', { current_password: currentPassword, new_password: newPassword })
      setCurrentPassword('')
      setNewPassword('')
      return '密码已修改'
    })
  }

  return (
    <>
      {error !== '' && <p className="banner error">{error}</p>}
      {message !== '' && <p className="banner ok">{message}</p>}
      <section className="panel">
        <header className="panel-head"><h1><i className="mark" />登录安全</h1></header>
        <div className="panel-body">
          <form className="panel-form" onSubmit={saveUsername}>
            <label>用户名<input value={username} autoComplete="username" required onChange={event => setUsername(event.target.value)} /></label>
            <button className="primary" type="submit" disabled={busy}>保存用户名</button>
          </form>
          <p>两步验证：<strong>{auth.totpEnabled ? '已开启' : '未开启'}</strong></p>
          {!auth.totpEnabled ? (
            setup === null ? (
              <button className="primary" type="button" disabled={busy} onClick={beginSetup}>开启两步验证</button>
            ) : (
              <form className="panel-form" onSubmit={confirmSetup}>
                <p className="muted">用验证器扫描二维码，或手动添加下面的密钥，再填写它给出的 6 位验证码。确认后才会真正开启。</p>
                <img className="qr" src={qrDataUrl} width={196} height={196} alt="两步验证二维码" />
                <p className="mono">{setup.secret}</p>
                <label>验证码<input value={confirmCode} inputMode="numeric" maxLength={6} required onChange={event => setConfirmCode(event.target.value)} /></label>
                <div className="row">
                  <button className="primary" type="submit" disabled={busy}>确认开启</button>
                  <button className="link" type="button" onClick={() => { setSetup(null); setQrDataUrl('') }}>取消</button>
                </div>
              </form>
            )
          ) : (
            <form className="panel-form" onSubmit={disable}>
              <label>密码<input value={disablePassword} type="password" autoComplete="current-password" required onChange={event => setDisablePassword(event.target.value)} /></label>
              <label>验证码<input value={disableCode} inputMode="numeric" maxLength={6} required onChange={event => setDisableCode(event.target.value)} /></label>
              <button className="primary" type="submit" disabled={busy}>关闭两步验证</button>
            </form>
          )}
        </div>
      </section>
      <section className="panel">
        <header className="panel-head"><h1><i className="mark" />修改密码</h1></header>
        <div className="panel-body">
          <form className="panel-form" onSubmit={changePassword}>
            <label>当前密码<input value={currentPassword} type="password" autoComplete="current-password" required onChange={event => setCurrentPassword(event.target.value)} /></label>
            <label>新密码<input value={newPassword} type="password" autoComplete="new-password" required onChange={event => setNewPassword(event.target.value)} /></label>
            <button className="primary" type="submit" disabled={busy}>保存</button>
          </form>
        </div>
      </section>
    </>
  )
}
