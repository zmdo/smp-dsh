import { componentRevision, type Component } from './catalog.ts'
import { observe } from './plans.ts'
import type { DetectedOs } from './operating-systems.ts'
import type { PackageIdentity } from './contracts.ts'
import { ServerError } from './i18n.ts'
import { excerpt, parseComposeVersion, parseDockerVersion, parsePs, type ParsedContainer } from './parse.ts'
import type { CommandResult, SshSession } from './ssh.ts'

export interface SoftwareProbe {
  state: 'installed' | 'missing' | 'unknown'
  installed: boolean
  detail: string
  version?: string
  revision?: string
  targetIdentity?: string
  healthy?: boolean
  packages?: readonly PackageIdentity[]
}

export type SoftwareStatus = Record<string, SoftwareProbe>

const DOCKER_VERSION = "docker version --format '{{json .}}'"
const COMPOSE_VERSION = 'docker compose version --format json'
const DOCKER_PS = "docker ps -a --no-trunc --format '{{json .}}'"

function probe(state: SoftwareProbe['state'], detail = '', version?: string): SoftwareProbe {
  return {
    state,
    installed: state === 'installed',
    detail: detail.slice(-500),
    ...(version === undefined ? {} : { version }),
  }
}

export function parseSoftwareProbe(result: CommandResult): SoftwareProbe {
  if (result.code !== 0) return probe('unknown', excerpt(result.stderr || result.stdout))
  let value: unknown
  try {
    value = JSON.parse(result.stdout.trim())
  } catch (cause) {
    void cause
    return probe('unknown', excerpt(result.stdout || result.stderr))
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return probe('unknown')
  const record = value as { state?: unknown; detail?: unknown; version?: unknown }
  if (record.state !== 'installed' && record.state !== 'missing' && record.state !== 'unknown') return probe('unknown')
  if (record.state === 'installed' && (typeof record.version !== 'string' || record.version.trim() === ''))
    return probe('unknown', 'Installed software did not report a version.')
  return probe(
    record.state,
    typeof record.detail === 'string' ? record.detail : '',
    typeof record.version === 'string' ? record.version.slice(0, 128) : undefined,
  )
}

export async function detectSoftware(
  session: SshSession,
  components: readonly Component[],
  os: DetectedOs,
): Promise<SoftwareStatus> {
  const result: SoftwareStatus = {}
  for (const component of components) {
    const value = await observe(session, component, os)
    result[component.id] = {
      ...value,
      installed: value.state === 'installed',
      detail: 'detail' in value ? (value.detail ?? '') : '',
      revision: componentRevision(component),
    }
  }
  return result
}

async function probeBuiltin(session: SshSession, id: string): Promise<SoftwareProbe> {
  const exists = await session.exec('command -v docker >/dev/null 2>&1', 15_000)
  if (exists.code === 1 || exists.code === 127) return probe('missing')
  if (exists.code !== 0) return probe('unknown', exists.stderr)
  const result = await session.exec(id === 'docker' ? DOCKER_VERSION : COMPOSE_VERSION, 15_000)
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout
    if (id === 'compose' && /['"]?compose['"]? is not a docker command|unknown command ['"]compose['"]/i.test(detail))
      return probe('missing', detail)
    return probe('unknown', detail)
  }
  try {
    return probe(
      'installed',
      '',
      id === 'docker' ? parseDockerVersion(result.stdout) : parseComposeVersion(result.stdout),
    )
  } catch (cause) {
    return probe('unknown', cause instanceof Error ? cause.message : '')
  }
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
    return {
      state: 'ready',
      docker: docker.version ?? null,
      compose: compose.version ?? null,
      containers: parsePs(listed.stdout),
    }
  } catch (cause) {
    void cause
    return { state: 'error', docker: null, compose: null }
  }
}
