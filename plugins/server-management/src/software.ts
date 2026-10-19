import { createHash } from 'node:crypto'
import { componentRevision, type Component } from './catalog.ts'
import { ServerError } from './i18n.ts'
import { excerpt, parseComposeVersion, parseDockerVersion, parsePs, type ParsedContainer } from './parse.ts'
import type { CommandResult, SshSession } from './ssh.ts'

export interface SoftwareProbe {
  state: 'installed' | 'missing' | 'unknown'
  installed: boolean
  detail: string
  version?: string
  revision?: string
}

export type SoftwareStatus = Record<string, SoftwareProbe>

const DOCKER_VERSION = "docker version --format '{{json .}}'"
const COMPOSE_VERSION = 'docker compose version --format json'
const DOCKER_PS = "docker ps -a --no-trunc --format '{{json .}}'"

function probe(state: SoftwareProbe['state'], detail = '', version?: string): SoftwareProbe {
  return { state, installed: state === 'installed', detail: detail.slice(-500), ...(version === undefined ? {} : { version }) }
}

export function parseSoftwareProbe(result: CommandResult): SoftwareProbe {
  if (result.code !== 0) return probe('unknown', excerpt(result.stderr || result.stdout))
  let value: unknown
  try { value = JSON.parse(result.stdout.trim()) } catch (cause) { void cause; return probe('unknown', excerpt(result.stdout || result.stderr)) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return probe('unknown')
  const record = value as { state?: unknown; detail?: unknown; version?: unknown }
  if (record.state !== 'installed' && record.state !== 'missing' && record.state !== 'unknown') return probe('unknown')
  return probe(record.state, typeof record.detail === 'string' ? record.detail : '', typeof record.version === 'string' ? record.version.slice(0, 128) : undefined)
}

export async function detectSoftware(session: SshSession, components: readonly Component[]): Promise<SoftwareStatus> {
  const status: SoftwareStatus = {}
  for (const component of components) {
    try {
      status[component.id] = component.detection === 'builtin'
        ? await probeBuiltin(session, component.id)
        : parseSoftwareProbe(await runSoftwareScript(session, component, 'detect', 30_000))
    } catch (cause) {
      status[component.id] = probe('unknown', cause instanceof Error ? cause.message : '')
    }
    status[component.id]!.revision = componentRevision(component)
  }
  return status
}

async function probeBuiltin(session: SshSession, id: string): Promise<SoftwareProbe> {
  const exists = await session.exec('command -v docker >/dev/null 2>&1', 15_000)
  if (exists.code === 1 || exists.code === 127) return probe('missing')
  if (exists.code !== 0) return probe('unknown', exists.stderr)
  const result = await session.exec(id === 'docker' ? DOCKER_VERSION : COMPOSE_VERSION, 15_000)
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout
    if (id === 'compose' && /['"]?compose['"]? is not a docker command|unknown command ['"]compose['"]/i.test(detail)) return probe('missing', detail)
    return probe('unknown', detail)
  }
  try {
    return probe('installed', '', id === 'docker' ? parseDockerVersion(result.stdout) : parseComposeVersion(result.stdout))
  } catch (cause) {
    return probe('unknown', cause instanceof Error ? cause.message : '')
  }
}

/** Unknown is never treated as missing, including a present Docker binary without daemon access. */
export async function installRequired(session: SshSession, components: readonly Component[], status: SoftwareStatus, reconnect?: () => Promise<SshSession>): Promise<SoftwareStatus> {
  if (Object.values(status).some(item => item.state === 'unknown')) throw new ServerError('software_detection_unknown')
  const next = { ...status }
  for (const component of components) {
    if (next[component.id]?.state === 'installed') continue
    const dependencies = component.requires.map(id => next[id])
    if (dependencies.some(item => item?.state !== 'installed')) throw new ServerError('software_dependency_unready', { component: component.id })
    const result = await runSoftwareScript(session, component, 'install', 600_000)
    if (result.code !== 0) throw new ServerError('component_install_failed', { component: component.name, exitCode: result.code, detail: excerpt(result.stderr || result.stdout, 500) })
    if (reconnect !== undefined) session = await reconnect()
    const verified = await detectSoftware(session, [component])
    if (verified[component.id]?.state !== 'installed') throw new ServerError('software_install_unverified', { component: component.id })
    next[component.id] = verified[component.id]!
  }
  return next
}

export interface ContainerObservation {
  state: 'ready' | 'unavailable' | 'error'
  docker: string | null
  compose: string | null
  containers?: ParsedContainer[]
}

/** Optional Docker inspection does not change SSH reachability or a type's software requirements. */
export async function inspectContainers(session: SshSession): Promise<ContainerObservation> {
  try {
    const docker = await probeBuiltin(session, 'docker')
    if (docker.state === 'missing') return { state: 'unavailable', docker: null, compose: null }
    if (docker.state !== 'installed') return { state: 'error', docker: null, compose: null }
    const compose = await probeBuiltin(session, 'compose')
    const listed = await session.exec(DOCKER_PS, 15_000)
    if (listed.code !== 0) return { state: 'error', docker: docker.version ?? null, compose: compose.version ?? null }
    return { state: 'ready', docker: docker.version ?? null, compose: compose.version ?? null, containers: parsePs(listed.stdout) }
  } catch (cause) {
    void cause
    return { state: 'error', docker: null, compose: null }
  }
}

export async function runSoftwareScript(session: SshSession, component: Component, kind: 'detect' | 'install', timeoutMs: number): Promise<CommandResult> {
  const key = createHash('sha256').update(component.recipe).digest('hex').slice(0, 20)
  const name = `${key}-${kind}.sh`
  await session.putScript(name, kind === 'detect' ? component.detectScript : component.installScript)
  return session.exec(`sh /tmp/smp-components/${name}`, timeoutMs)
}
