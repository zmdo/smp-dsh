import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Client, ConnectConfig } from 'ssh2'

const { Client: SshClient, utils } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2')

export class SshError extends Error {
  readonly fingerprint?: string

  constructor(message: string, fingerprint?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SshError'
    this.fingerprint = fingerprint
  }
}

export class FingerprintMismatch extends SshError {
  constructor(actual: string) {
    super(`主机密钥指纹不符，连接已拒绝。当前指纹是 ${actual}`, actual)
    this.name = 'FingerprintMismatch'
  }
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface SshSession {
  readonly fingerprint: string
  exec(command: string, timeoutMs: number): Promise<CommandResult>
  putScript(name: string, body: Buffer): Promise<void>
  shell(cols: number, rows: number): Promise<ShellChannel>
  close(): void
}

export interface ShellChannel {
  write(data: Buffer | string): void
  resize(cols: number, rows: number): void
  onData(listener: (chunk: Buffer) => void): void
  onClose(listener: () => void): void
  close(): void
}

const REMOTE_DIR = '/tmp/smp-components'

export function fingerprintOf(raw: Buffer): string {
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`
}

/** OpenSSH-style fingerprint of a PEM private key. A passphrase is refused. */
export function keyFingerprint(secret: string): string {
  const normalized = normalizePem(secret)
  let parsed: unknown
  try {
    parsed = utils.parseKey(normalized)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : ''
    if (message.toLowerCase().includes('passphrase') || message.toLowerCase().includes('encrypted')) {
      throw new SshError('私钥带有口令。请先去掉口令，再保存到控制台。', undefined, { cause })
    }
    throw new SshError('私钥无法解析，请确认粘贴的是完整的私钥文件。', undefined, { cause })
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (key instanceof Error || key === undefined || typeof key.getPublicSSH !== 'function') {
    const message = key instanceof Error ? key.message : ''
    if (message.toLowerCase().includes('passphrase') || message.toLowerCase().includes('encrypted')) {
      throw new SshError('私钥带有口令。请先去掉口令，再保存到控制台。', undefined, { cause: key })
    }
    throw new SshError('私钥无法解析，请确认粘贴的是完整的私钥文件。', undefined, { cause: key instanceof Error ? key : undefined })
  }
  return fingerprintOf(key.getPublicSSH())
}

export function connectSsh(input: {
  host: string
  port: number
  username: string
  authMethod: string
  secret: string
  expectedFingerprint: string | null
}): Promise<SshSession> {
  return new Promise((resolve, reject) => {
    const client = new SshClient()
    let seen = ''
    let mismatch = ''
    let settled = false
    const fail = (error: SshError) => {
      if (settled) return
      settled = true
      client.end()
      reject(error)
    }
    const config: ConnectConfig = {
      host: input.host,
      port: input.port,
      username: input.username,
      readyTimeout: 8000,
      tryKeyboard: false,
      hostVerifier: (key) => {
        seen = fingerprintOf(Buffer.isBuffer(key) ? key : Buffer.from(key))
        if (input.expectedFingerprint && seen !== input.expectedFingerprint) {
          mismatch = seen
          return false
        }
        return true
      },
    }
    if (input.authMethod === 'password') config.password = input.secret
    else if (input.authMethod === 'private_key') config.privateKey = normalizePem(input.secret)
    else {
      fail(new SshError('不支持的认证方式'))
      return
    }
    client.on('ready', () => {
      if (settled) return
      if (seen === '') {
        fail(new SshError('没有读到主机密钥指纹'))
        return
      }
      settled = true
      resolve(sessionFor(client, seen))
    })
    client.on('error', (cause: Error) => {
      if (mismatch !== '') {
        fail(new FingerprintMismatch(mismatch))
        return
      }
      fail(mapConnectError(cause, seen))
    })
    client.connect(config)
  })
}

function sessionFor(client: Client, fingerprint: string): SshSession {
  return {
    fingerprint,
    exec: (command, timeoutMs) => execCommand(client, command, timeoutMs),
    putScript: (name, body) => uploadScript(client, name, body),
    shell: (cols, rows) => openShell(client, cols, rows),
    close: () => { client.end() },
  }
}

function execCommand(client: Client, command: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, { timeout: timeoutMs }, (cause, stream) => {
      if (cause) {
        reject(new SshError(`无法执行命令：${cause.message}`, undefined, { cause }))
        return
      }
      const out: Buffer[] = []
      const err: Buffer[] = []
      stream.on('data', (chunk: Buffer) => { out.push(chunk) })
      stream.stderr.on('data', (chunk: Buffer) => { err.push(chunk) })
      stream.on('close', (code: number) => {
        resolve({
          code: code ?? 0,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        })
      })
    })
  })
}

function uploadScript(client: Client, name: string, body: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((cause, sftp) => {
      if (cause) {
        reject(new SshError(`无法把安装脚本传到服务器：${cause.message}`, undefined, { cause }))
        return
      }
      sftp.mkdir(REMOTE_DIR, (mkdirCause) => {
        void mkdirCause
        const remote = `${REMOTE_DIR}/${name}`
        const handle = sftp.createWriteStream(remote, { mode: 0o700 })
        handle.on('error', (error: Error) => {
          sftp.end()
          reject(new SshError(`无法把安装脚本传到服务器：${error.message}`, undefined, { cause: error }))
        })
        handle.on('close', () => {
          sftp.end()
          resolve()
        })
        handle.end(body.toString('utf8').replaceAll('\r\n', '\n'))
      })
    })
  })
}

function openShell(client: Client, cols: number, rows: number): Promise<ShellChannel> {
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols, rows }, (cause, stream) => {
      if (cause) {
        reject(new SshError(`无法打开终端：${cause.message}`, undefined, { cause }))
        return
      }
      resolve({
        write: (data) => { stream.write(data) },
        resize: (nextCols, nextRows) => { stream.setWindow(nextRows, nextCols, 0, 0) },
        onData: (listener) => { stream.on('data', listener) },
        onClose: (listener) => { stream.on('close', listener) },
        close: () => { stream.close() },
      })
    })
  })
}

function mapConnectError(cause: Error, fingerprint: string): SshError {
  const message = cause.message.toLowerCase()
  if (message.includes('authentication') || message.includes('all configured authentication')) {
    return new SshError('SSH 认证失败，请检查用户名、私钥或口令。', fingerprint || undefined, { cause })
  }
  if (message.includes('timed out') || message.includes('timeout')) {
    return new SshError('连接超时。确认地址、端口，以及控制机能访问这台机器。', fingerprint || undefined, { cause })
  }
  if (message.includes('econnrefused')) {
    return new SshError('连接被拒绝。确认这台机器的 SSH 已启动，端口填写正确。', fingerprint || undefined, { cause })
  }
  if (message.includes('passphrase') || message.includes('encrypted')) {
    return new SshError('私钥带有口令。请先去掉口令，再保存到控制台。', undefined, { cause })
  }
  return new SshError(`无法连接 SSH：${cause.message}`, fingerprint || undefined, { cause })
}

function normalizePem(secret: string): string {
  const text = secret.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}
