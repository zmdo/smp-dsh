import { readPolicies, restrictLease } from './policies.ts'
import { preflightRequest, savePreflight, type ChangeRequest } from './changes.ts'
import { detectUpdates, saveUpdateChecks } from './upgrades.ts'
import type { DefinitionRegistry, TypeLease } from './registry.ts'
import { typeSupportsOs } from './definitions.ts'
import { osVerification } from './operating-systems.ts'
import { probeOs } from './os-probe.ts'
import { errorPayload, ServerError } from './i18n.ts'
import { scrub, scrubValue } from './parse.ts'
import { connectSsh, type SshSession } from './ssh.ts'
import { detectSoftware, inspectContainers, type SoftwareStatus } from './software.ts'
import {
  markConnected,
  saveComponentStatus,
  saveObservation,
  saveOsProbe,
  serverSecret,
  type Db,
} from './store.ts'
import {
  finishJob,
  heartbeat,
  loadPlan,
  owned,
  phase,
  recovering,
  savePlan,
  type JobRecord,
} from './job-store.ts'
import { canonical, validObservation } from './recipe.ts'
import { checkPlan, preparePlan, type PreparedPlan } from './plans.ts'
import { remoteOperation, type RemoteResult } from './remote-operation.ts'
import { randomUUID } from 'node:crypto'

interface Secrets {
  decrypt(ciphertext: string): string
}
export async function executeJob(
  db: Db,
  secrets: Secrets,
  definitions: DefinitionRegistry,
  job: JobRecord,
  connect: typeof connectSsh = connectSsh,
  updateCheckIntervalSeconds = 3600,
): Promise<void> {
  let session: SshSession | undefined,
    lease: TypeLease | undefined,
    secret = '',
    connected = false,
    mutation = job.mutation_phase !== null,
    leaseLost = false
  const heartbeats = new Set<Promise<void>>()
  const timer = setInterval(() => {
    const task = heartbeat(db, job)
      .then(
        (ok) => {
          if (!ok) leaseLost = true
        },
        () => {
          leaseLost = true
        },
      )
      .finally(() => heartbeats.delete(task))
    heartbeats.add(task)
  }, 15_000)
  const guard = async () => {
    if (leaseLost || !(await heartbeat(db, job))) throw new ServerError('job_lease_lost')
  }
  try {
    await guard()
    let server = await serverSecret(db, job.server_id)
    if (!server) throw new ServerError('server_not_found')
    if (String(server.config_revision) !== String(job.expected_config_revision))
      throw new ServerError('job_configuration_changed')
    secret = secrets.decrypt(server.secret_ciphertext)
    session = await connect({
      host: server.host,
      port: server.ssh_port,
      username: server.ssh_user,
      authMethod: server.auth_method,
      secret,
      expectedFingerprint: server.host_fingerprint,
    })
    connected = true
    await owned(db, job, (client) => markConnected(client, server!.id, session!.fingerprint))
    // Recovery must remain possible when a provider has unloaded. The remote journal contains the accepted scripts and result.
    if (job.purpose === 'apply_plan' && job.state === 'recovering' && mutation) {
      const saved = await loadPlan(db, job)
      if (!saved) {
        await recovering(db, job, '安装计划不可用，需要人工核对远端操作。')
        return
      }
      const result = await remoteOperation(session, 'recover', job.operation_id, saved.digest)
      await reconcile(db, job, result, secret, saved.plan)
      return
    }
    let explicit: ChangeRequest | undefined
    if (job.target_id && job.purpose !== 'apply_plan') explicit = await preflightRequest(db, job)
    if (job.purpose === 'apply_plan') {
      const accepted = await loadPlan(db, job)
      if (!accepted) throw new ServerError('plan_not_ready')
      explicit = accepted.request
    }
    const probe = await probeOs(session, server.declared_os)
    await owned(db, job, (client) => saveOsProbe(client, server!.id, probe, server!.config_revision))
    const verified = osVerification(
      server.declared_os,
      probe.state === 'detected' ? probe.os : null,
      probe.state,
    )
    if (verified === 'mismatch') throw new ServerError('os_mismatch')
    lease = await definitions.lease(
      explicit?.selection?.binding ? explicit.selection.binding.groupId : server.group_id,
      explicit?.selection?.binding?.typeKey ?? server.type_key,
      probe.state === 'detected' ? probe.os : server.declared_os,
    )
    if (lease)
      lease = restrictLease(
        lease,
        explicit?.selection?.binding?.policies ?? (await readPolicies(db, server.id)),
      )
    if (job.purpose === 'apply_plan' || job.request_snapshot.prepare) {
      if (!lease) throw new ServerError('type_unavailable')
      if (job.definition_revision !== lease.signature) throw new ServerError('job_definition_changed')
    }
    if (lease?.components.length) {
      if (verified !== 'matched' || probe.state !== 'detected') throw new ServerError('os_unverified')
      if (!typeSupportsOs(lease.type, probe.os)) throw new ServerError('os_type_unsupported')
    }
    server = (await serverSecret(db, job.server_id))!
    await phase(db, job, 'preflight')
    if (job.purpose === 'detect_updates') {
      if (!lease || probe.state !== 'detected' || verified !== 'matched')
        throw new ServerError('os_unverified')
      const enabled = job.request_snapshot.automatic
        ? (await readPolicies(db, server.id)).filter((p) => p.detect_updates).map((p) => p.software_key)
        : undefined
      const checks = await detectUpdates(session, lease, probe.os, enabled)
      await saveUpdateChecks(db, job, server, lease, scrubValue(checks, secret), updateCheckIntervalSeconds)
      const issues = checks.filter(
        (c) =>
          c.reason === 'detection_failed' ||
          c.reason === 'version_conflict' ||
          c.reason === 'unhealthy' ||
          c.errors.length,
      )
      await finishJob(
        db,
        job,
        issues.length ? 'failed' : 'succeeded',
        issues.length ? '升级检测发现异常。' : '升级检测完成；未执行软件变更。',
        { summary: 'updates_detected', checks: scrubValue(checks, secret) },
      )
      return
    }
    if (job.target_id && job.purpose !== 'apply_plan' && explicit) {
      if (!lease || probe.state !== 'detected' || verified !== 'matched')
        throw new ServerError('os_unverified')
      const plan = await preparePlan(session, lease, probe.os, {
        mode: explicit.selection.binding ? 'move' : 'upgrade',
        versions: explicit.selection.versions,
        installMissing: explicit.selection.binding?.installMissing,
      })
      if (explicit.selection.binding) plan.targetType = lease.type
      await owned(db, job, (c) => savePreflight(c, job, server!, plan))
      await finishJob(db, job, 'succeeded', '预检完成，等待确认；未执行软件变更。', {
        summary: 'preflight_ready',
      })
      return
    }
    if (job.purpose === 'apply_plan') {
      const saved = await loadPlan(db, job)
      if (
        !saved ||
        !lease ||
        probe.state !== 'detected' ||
        canonical(saved.plan.os) !== canonical(probe.os) ||
        String(server.environment_revision) !== String(job.expected_environment_revision)
      )
        throw new ServerError('plan_conflict')
      await checkPlan(session, lease, saved.plan)
      await guard()
      const admitted = await loadPlan(db, job, true)
      if (!admitted) throw new ServerError('plan_not_ready')
      mutation = true
      const changing = saved.plan.changes.some((c) => ['install', 'upgrade', 'replace'].includes(c.action))
      let result: RemoteResult = changing
        ? await remoteOperation(session, 'start', job.operation_id, saved.digest, saved.plan, lease)
        : {
            state: 'completed',
            steps: saved.plan.changes.map((change, index) => ({
              ordinal: index + 1,
              software: change.software,
              state: 'succeeded',
              changes: [],
              after: change.before,
            })),
          }
      while (result.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await guard()
        result = await remoteOperation(session, 'recover', job.operation_id, saved.digest)
      }
      await phase(db, job, 'verifying')
      const actual = await detectSoftware(session, lease.components, probe.os)
      await owned(db, job, (client) =>
        saveComponentStatus(client, server!.id, clean(actual, secret), lease!.components),
      )
      await reconcile(db, job, result, secret, saved.plan)
      return
    }
    const status =
      lease && probe.state === 'detected'
        ? await detectSoftware(session, lease.components, probe.os)
        : undefined
    const observation =
      verified === 'matched' && probe.state === 'detected' && probe.os.family !== 'builtin/windows-server'
        ? await inspectContainers(session)
        : { state: 'unavailable' as const, docker: null, compose: null }
    await owned(db, job, (client) =>
      saveObservation(
        client,
        server!.id,
        job.id,
        status ? clean(status, secret) : undefined,
        scrubValue(observation, secret),
        '',
        lease?.components ?? [],
      ),
    )
    if (!job.request_snapshot.prepare) {
      const issues: ReturnType<typeof errorPayload>[] = []
      if (probe.state === 'failed') issues.push(errorPayload(new ServerError('os_probe_failed')))
      if (!lease) issues.push(errorPayload(new ServerError('type_unavailable')))
      for (const [software, item] of Object.entries(status ?? {})) {
        if (item.state === 'unknown' || (item.state === 'installed' && item.healthy === false))
          issues.push(
            errorPayload(new ServerError('inspection_software_failed', { software, detail: item.detail })),
          )
      }
      if (observation.state === 'error')
        issues.push(errorPayload(new ServerError('containers_failed', { detail: observation.detail ?? '' })))
      if (issues.length) {
        await finishJob(db, job, 'failed', '巡检发现检测异常。', {
          summary: 'inspection_issues',
          issues: scrubValue(issues, secret),
        })
        return
      }
    }
    if (job.request_snapshot.prepare && lease?.components.length) {
      if (probe.state !== 'detected') throw new ServerError('os_unverified')
      const plan = await preparePlan(session, lease, probe.os)
      if (plan.changes.some((change) => change.action === 'install')) await savePlan(db, job, server, plan)
    }
    await finishJob(
      db,
      job,
      'succeeded',
      job.request_snapshot.prepare ? '检查完成；缺失软件将按独立安装计划处理。' : '只读检查完成。',
      { summary: job.request_snapshot.prepare ? 'prepared' : 'inspected' },
    )
  } catch (cause) {
    if (cause instanceof ServerError && cause.code === 'job_lease_lost') return
    const message = scrub(cause instanceof Error ? cause.message : '任务失败。', secret)
    if (mutation) {
      await recovering(db, job, message)
      return
    }
    if (!connected)
      await owned(db, job, (client) =>
        client
          .query(
            "update server_runtime set connection_state='offline',connection_checked_at=now(),connection_error=$2 where server_id=$1",
            [job.server_id, JSON.stringify({ message })],
          )
          .then(() => {}),
      )
    await finishJob(
      db,
      job,
      'failed',
      message,
      cause instanceof ServerError ? { error: scrubValue(errorPayload(cause), secret) } : null,
    )
  } finally {
    clearInterval(timer)
    await Promise.all(heartbeats)
    session?.close()
    lease?.release()
  }
}
async function reconcile(
  db: Db,
  job: JobRecord,
  result: RemoteResult,
  secret: string,
  plan: PreparedPlan,
): Promise<void> {
  if (result.state === 'not-started') {
    await finishJob(db, job, 'failed', '远端安装未启动；可重新检查并准备新计划。', {
      summary: 'not_started',
      steps: [],
    })
    return
  }
  if (result.state !== 'completed' && result.state !== 'failed') {
    await recovering(
      db,
      job,
      result.state === 'running' ? '远端安装仍在进行。' : '远端结果尚不能确定，已保留服务器执行锁。',
      result.state === 'running' ? 'running' : 'unknown',
    )
    return
  }
  for (const step of result.steps) {
    const change = plan.changes[step.ordinal - 1]
    if (
      !change ||
      change.software !== step.software ||
      (step.after !== undefined && !validObservation(step.after))
    )
      throw new ServerError('recipe_protocol')
  }
  if (
    result.state === 'completed' &&
    (result.steps.length !== plan.changes.length ||
      new Set(result.steps.map((step) => step.ordinal)).size !== plan.changes.length ||
      result.steps.some((step) => {
        const change = plan.changes[step.ordinal - 1]!,
          actual = step.after
        if (step.state !== 'succeeded' || !validObservation(actual)) return true
        if (change.action === 'keep' || change.action === 'defer-install')
          return canonical(actual) !== canonical(change.before)
        return (
          actual.state !== 'installed' ||
          !actual.healthy ||
          actual.targetIdentity !== change.target?.targetIdentity
        )
      }))
  )
    throw new ServerError('recipe_protocol')
  const cleaned = {
    ...scrubValue(result, secret),
    ...(result.state === 'completed'
      ? {
          summary:
            job.request_snapshot.action === 'upgrade_software'
              ? 'upgraded'
              : job.request_snapshot.action === 'move_server'
                ? 'moved'
                : 'installed',
        }
      : {}),
  } as RemoteResult
  await owned(db, job, async (client) => {
    for (const step of cleaned.steps) {
      const change = plan.changes[step.ordinal - 1]!
      if (validObservation(step.after))
        await saveComponentStatus(
          client,
          job.server_id,
          {
            [step.software]: {
              ...step.after,
              installed: step.after.state === 'installed',
              detail: 'detail' in step.after ? (step.after.detail ?? '') : '',
              revision: change.recipeRevision,
            },
          },
          [
            {
              id: step.software,
              software_key: step.software,
              recipe: change.recipe,
            },
          ],
        )
    }
    for (const step of cleaned.steps)
      await client.query(
        `insert into server_job_steps(id,job_id,ordinal,software_key,phase,state,after_snapshot,changes,error,finished_at)
      values($1,$2,$3,$4,$9,$5,$6,$7,$8,now()) on conflict(job_id,ordinal) do update set state=excluded.state,after_snapshot=excluded.after_snapshot,changes=excluded.changes,error=excluded.error,finished_at=excluded.finished_at`,
        [
          randomUUID(),
          job.id,
          step.ordinal,
          step.software,
          step.state === 'succeeded' ? 'succeeded' : 'failed',
          JSON.stringify(step.after ?? null),
          JSON.stringify(step.changes),
          result.error ? JSON.stringify({ message: scrub(result.error, secret) }) : null,
          job.mutation_phase ?? 'installing',
        ],
      )
  })
  await finishJob(
    db,
    job,
    result.state === 'completed' ? 'succeeded' : 'failed',
    result.state === 'completed'
      ? '已完成安装并验证。'
      : scrub(result.error ?? '安装失败；请查看已发生的远端变化。', secret),
    cleaned,
  )
}
function clean(status: SoftwareStatus, secret: string): SoftwareStatus {
  return scrubValue(status, secret)
}
