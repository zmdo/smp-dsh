import { DefinitionRegistry, type TypeLease } from './registry.ts'
import { isKnownAction, UNIMPLEMENTED_MESSAGE } from './jobs.ts'
import { ServerError } from './i18n.ts'
import { scrub } from './parse.ts'
import { connectSsh, type SshSession } from './ssh.ts'
import { detectSoftware, inspectContainers, installRequired, type SoftwareStatus } from './software.ts'
import { finishJob, loadJob, markConnected, recordFailure, saveComponentStatus, saveObservation, serverSecret, type Db } from './store.ts'

interface Secrets {
  decrypt(ciphertext: string): string
}

/** Every mutating job is bound to the configuration and type definition accepted at enqueue time. */
export async function executeJob(db: Db, secrets: Secrets, definitions: DefinitionRegistry, jobId: string, connect: typeof connectSsh = connectSsh): Promise<void> {
  const job = await loadJob(db, jobId)
  if (job === undefined || job.status !== 'running') return
  if (!isKnownAction(job.action)) {
    await finishJob(db, jobId, 'failed', UNIMPLEMENTED_MESSAGE)
    return
  }
  const server = await serverSecret(db, job.server_id)
  if (server === undefined) {
    await finishJob(db, jobId, 'failed', new ServerError('server_not_found').message)
    return
  }
  if (job.config_revision !== null && String(job.config_revision) !== String(server.config_revision)) {
    await finishJob(db, jobId, 'failed', new ServerError('job_configuration_changed').message)
    return
  }
  let secret = ''
  try { secret = secrets.decrypt(server.secret_ciphertext) } catch (cause) {
    void cause
    await finishJob(db, jobId, 'failed', new ServerError('secret_unavailable').message)
    return
  }
  let session: SshSession | undefined
  let lease: TypeLease | undefined
  let connected = false
  try {
    const open = () => connect({ host: server.intranet_host, port: server.ssh_port, username: server.ssh_user, authMethod: server.auth_method, secret, expectedFingerprint: server.host_key_fingerprint })
    session = await open()
    connected = true
    await markConnected(db, server.id, session.fingerprint)
    lease = await definitions.lease(server.group_id, server.type_key)
    if (job.action === 'install_components' && lease === undefined) throw new ServerError('type_unavailable')
    const install = job.action === 'install_components' || (job.action === 'test_connection' && server.auto_install)
    if (install && lease !== undefined && lease.components.length > 0
      && (job.type_signature !== lease.signature || job.config_revision === null)) throw new ServerError('job_definition_changed')
    let status = lease === undefined ? undefined : await detectSoftware(session, lease.components)
    if (install && lease !== undefined && lease.components.length > 0 && status !== undefined) {
      status = await installRequired(session, lease.components, status, async () => {
        const fingerprint = session!.fingerprint
        session!.close()
        session = await connect({ host: server.intranet_host, port: server.ssh_port, username: server.ssh_user, authMethod: server.auth_method, secret, expectedFingerprint: fingerprint })
        return session
      })
      status = await detectSoftware(session, lease.components)
      if (Object.values(status).some(item => item.state !== 'installed')) throw new ServerError('software_install_unverified', { component: server.type_key })
    }
    const observation = await inspectContainers(session)
    const summary = lease === undefined ? '类型定义不可用，未执行必要软件脚本。'
      : lease.components.length === 0 ? '没有必要软件。'
      : `必要软件：${Object.values(status ?? {}).filter(item => item.state === 'installed').length}/${lease.components.length} 已安装。`
    const output = `SSH 已连接。${summary} 容器巡检：${observation.state}。主机指纹 ${session.fingerprint}。`
    await saveObservation(db, server.id, jobId, status === undefined ? undefined : clean(status, secret), observation, scrub(output, secret))
  } catch (cause) {
    if (session !== undefined && lease !== undefined) {
      const actual = await detectSoftware(session, lease.components)
      await saveComponentStatus(db, server.id, clean(actual, secret))
    }
    const message = cause instanceof Error ? cause.message : new ServerError('connection_failed').message
    await recordFailure(db, server.id, jobId, scrub(message, secret), connected)
  } finally {
    session?.close()
    lease?.release()
  }
}

function clean(status: SoftwareStatus, secret: string): SoftwareStatus {
  return Object.fromEntries(Object.entries(status).map(([id, item]) => [id, {
    ...item, detail: scrub(item.detail, secret), ...(item.version === undefined ? {} : { version: scrub(item.version, secret) }),
  }]))
}
