import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CatalogError, loadCatalog, normalizeSelection } from './catalog.ts'
import { isKnownAction, UNIMPLEMENTED_MESSAGE } from './jobs.ts'
import { dockerAccessMessage, excerpt, parseComposeVersion, parseDockerVersion, parsePs, scrub } from './parse.ts'
import { FingerprintMismatch, SshError, connectSsh, type SshSession } from './ssh.ts'
import {
  finishJob,
  loadJob,
  replaceContainers,
  saveComponentStatus,
  saveFailure,
  saveProbe,
  serverSecret,
  type Db,
} from './store.ts'

const DOCKER_VERSION = "docker version --format '{{json .}}'"
const COMPOSE_VERSION = 'docker compose version --format json'
const DOCKER_PS = "docker ps -a --no-trunc --format '{{json .}}'"

interface Secrets {
  decrypt(ciphertext: string): string
}

/** Run one claimed job. The row is already `running`. */
export async function executeJob(db: Db, secrets: Secrets, componentsDir: string, jobId: string): Promise<void> {
  const job = await loadJob(db, jobId)
  if (job === undefined || job.status !== 'running') return
  if (!isKnownAction(job.action)) {
    await finishJob(db, jobId, 'failed', UNIMPLEMENTED_MESSAGE)
    return
  }
  const server = await serverSecret(db, job.server_id)
  if (server === undefined) {
    await finishJob(db, jobId, 'failed', '服务器不存在')
    return
  }
  let secret = ''
  try {
    secret = secrets.decrypt(server.secret_ciphertext)
  } catch (cause) {
    void cause
    await saveFailure(db, server.id, jobId, '无法解密', false, undefined, false)
    return
  }
  try {
    if (job.action === 'inspect') await runInspect(db, jobId, server, secret)
    else {
      const catalog = await loadCatalog(componentsDir)
      const selected = job.action === 'install_components'
        ? catalog.map(item => item.id)
        : server.auto_install ? normalizeSelection(catalog, parseIds(server.install_component_ids)) : []
      await runPrepare(db, componentsDir, jobId, server, secret, selected)
    }
  } catch (cause) {
    if (cause instanceof CatalogError) {
      await finishJob(db, jobId, 'failed', cause.message)
      return
    }
    const error = cause instanceof SshError ? cause : new SshError('连接测试失败', undefined, { cause })
    const dockerDown = !(cause instanceof FingerprintMismatch) && isDockerProblem(error.message)
    await saveFailure(
      db,
      server.id,
      jobId,
      scrub(error.message, secret),
      dockerDown,
      error.fingerprint,
      !(cause instanceof FingerprintMismatch),
    )
  }
}

async function runPrepare(db: Db, componentsDir: string, jobId: string, server: Awaited<ReturnType<typeof serverSecret>> & object, secret: string, componentIds: string[]): Promise<void> {
  let session = await open(server, secret)
  try {
    let status = await detect(session, componentsDir)
    await saveComponentStatus(db, server.id, status)
    const report = componentIds.length > 0 ? await installMissing(session, componentsDir, componentIds) : undefined
    if (report?.changed) {
      const fingerprint = session.fingerprint
      session.close()
      session = await open({ ...server, host_key_fingerprint: fingerprint }, secret)
    }
    if (report !== undefined) {
      status = await detect(session, componentsDir)
      await saveComponentStatus(db, server.id, status)
    }
    const versions = await readVersions(session)
    let output = `已连接。Docker ${versions.docker}，Compose ${versions.compose}。主机指纹 ${session.fingerprint}。`
    if (report !== undefined && report.notes.length > 0) output = `${report.notes.join(' ')} ${output}`
    await saveProbe(db, server.id, jobId, session.fingerprint, versions.docker, versions.compose, scrub(output, secret))
  } finally {
    session.close()
  }
}

async function runInspect(db: Db, jobId: string, server: NonNullable<Awaited<ReturnType<typeof serverSecret>>>, secret: string): Promise<void> {
  const session = await open(server, secret)
  try {
    const versions = await readVersions(session)
    const listed = await session.exec(DOCKER_PS, 15_000)
    if (listed.code !== 0) {
      const access = dockerAccessMessage(listed.stderr)
      throw new SshError(access ?? excerpt(listed.stderr || listed.stdout || '无法读取容器清单'))
    }
    const containers = parsePs(listed.stdout)
    const output = scrub(`巡检完成，${containers.length} 个容器。Docker ${versions.docker}。`, secret)
    await db.query(
      `update servers set docker_version = $2, compose_version = $3, host_key_fingerprint = $4, updated_at = now() where id = $1`,
      [server.id, versions.docker, versions.compose, session.fingerprint],
    )
    await replaceContainers(db, server.id, jobId, containers, output)
  } finally {
    session.close()
  }
}

async function open(server: { intranet_host: string; ssh_port: number; ssh_user: string; auth_method: string; host_key_fingerprint: string | null }, secret: string): Promise<SshSession> {
  return connectSsh({
    host: server.intranet_host,
    port: server.ssh_port,
    username: server.ssh_user,
    authMethod: server.auth_method,
    secret,
    expectedFingerprint: server.host_key_fingerprint,
  })
}

async function readVersions(session: SshSession): Promise<{ docker: string; compose: string }> {
  const docker = await session.exec(DOCKER_VERSION, 15_000)
  if (docker.code !== 0) {
    const access = dockerAccessMessage(docker.stderr)
    throw new SshError(access ?? '无法读取 Docker 版本')
  }
  const compose = await session.exec(COMPOSE_VERSION, 15_000)
  if (compose.code !== 0) throw new SshError(dockerAccessMessage(compose.stderr) ?? '无法读取 Docker Compose 版本')
  return { docker: parseDockerVersion(docker.stdout), compose: parseComposeVersion(compose.stdout) }
}

async function detect(session: SshSession, componentsDir: string): Promise<Record<string, { installed: boolean; detail: string }>> {
  const catalog = await loadCatalog(componentsDir)
  const status: Record<string, { installed: boolean; detail: string }> = {}
  for (const component of catalog) {
    const result = await runScript(session, componentsDir, component.id, 'detect', 30_000)
    const line = result.stdout.split('\n').map(item => item.trim()).find(item => item !== '') ?? ''
    status[component.id] = { installed: result.code === 0, detail: line.slice(0, 120) }
  }
  return status
}

async function installMissing(session: SshSession, componentsDir: string, ids: string[]): Promise<{ notes: string[]; changed: boolean }> {
  const wanted = new Set(ids)
  const notes: string[] = []
  let changed = false
  for (const component of await loadCatalog(componentsDir)) {
    if (!wanted.has(component.id)) continue
    const detected = await runScript(session, componentsDir, component.id, 'detect', 30_000)
    if (detected.code === 0) {
      notes.push(`${component.name} 已安装，跳过`)
      continue
    }
    const installed = await runScript(session, componentsDir, component.id, 'install', 600_000)
    if (installed.code !== 0) {
      const detail = (installed.stderr || installed.stdout).trim()
      throw new SshError(`${component.name} 安装失败：${detail.slice(-500) || `退出码 ${installed.code}`}`)
    }
    notes.push(`已安装 ${component.name}`)
    changed = true
  }
  return { notes, changed }
}

async function runScript(session: SshSession, componentsDir: string, id: string, kind: 'detect' | 'install', timeoutMs: number) {
  const body = await readFile(join(componentsDir, id, `${kind}.sh`))
  await session.putScript(`${id}-${kind}.sh`, body)
  return session.exec(`sh /tmp/smp-components/${id}-${kind}.sh`, timeoutMs)
}

function parseIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.map(item => String(item)) : []
  } catch (cause) {
    void cause
    return []
  }
}

function isDockerProblem(message: string): boolean {
  return message.includes('Docker') || message.includes('Compose') || message.includes('docker')
}
