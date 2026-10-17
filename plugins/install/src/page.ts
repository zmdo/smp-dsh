/** Standalone install document. The shell is not loaded, so this page does not call it. */
export const INSTALL_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>连接数据库</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">
<style>
  :root {
    --bg: #f4f6f8; --text: #323232; --muted: #8a8f99; --border: #dcdfe6;
    --primary: #005eeb; --red-bg: #fdecec;
    color: var(--text);
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px; line-height: 1.5;
  }
  * { box-sizing: border-box; }
  body { margin: 0; }
  button, input { font: inherit; color: inherit; }
  button { cursor: pointer; }
  .login-wrap {
    height: 100vh; overflow: auto; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(900px 420px at 50% -10%, rgba(0, 94, 235, 0.08), transparent 60%), var(--bg);
  }
  .login-card {
    width: min(440px, 100%); background: #fff; border-radius: 6px;
    box-shadow: 0 8px 28px rgba(31, 35, 41, 0.08); padding: 32px 32px 28px;
  }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 650; }
  .muted { margin: 0 0 18px; color: var(--muted); }
  label { display: grid; gap: 6px; margin-bottom: 14px; color: #606266; }
  input {
    height: 32px; border: 1px solid var(--border); background: #fff; border-radius: 4px; padding: 0 10px; outline: none;
  }
  input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(0, 94, 235, 0.12); }
  button.primary {
    width: 100%; height: 36px; border-radius: 4px; border: 1px solid var(--primary);
    background: var(--primary); color: #fff;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .banner { background: var(--red-bg); border: 1px solid #f6c9c9; color: #c43838; padding: 8px 12px; border-radius: 4px; margin: 0 0 14px; }
  [hidden] { display: none; }
</style>
</head>
<body>
  <div class="login-wrap">
    <form class="login-card">
      <h1>连接数据库</h1>
      <p class="muted">填写数据库地址和加密密钥。连接成功后，这一页会关闭。</p>
      <p class="banner" hidden></p>
      <label>数据库地址<input name="databaseUrl" autocomplete="off" required></label>
      <label>加密密钥<input name="encryptionKey" type="password" autocomplete="off" required></label>
      <button class="primary" type="submit">连接</button>
    </form>
  </div>
<script>
  const form = document.querySelector('form')
  const banner = document.querySelector('.banner')
  const button = form.querySelector('button')
  form.addEventListener('submit', function (event) {
    event.preventDefault()
    banner.hidden = true
    button.disabled = true
    const body = {
      databaseUrl: new FormData(form).get('databaseUrl'),
      encryptionKey: new FormData(form).get('encryptionKey'),
    }
    fetch('/console-api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json().then(function (payload) {
        return { ok: response.ok, payload: payload }
      })
    }).then(function (result) {
      if (result.ok && result.payload.ok === true) {
        window.location.assign('/')
        return
      }
      banner.textContent = typeof result.payload.detail === 'string' ? result.payload.detail : '连接失败'
      banner.hidden = false
      button.disabled = false
    }).catch(function () {
      banner.textContent = '连接失败'
      banner.hidden = false
      button.disabled = false
    })
  })
</script>
</body>
</html>
`
