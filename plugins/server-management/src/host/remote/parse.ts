export interface ParsedContainer {
  containerId: string
  name: string
  image: string
  status: string
  ports: string
  managed: boolean
  strategySlug: string | null
}

export class ParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ParseError'
  }
}

export function excerpt(text: string, limit = 8000): string {
  const cleaned = text.trim()
  if (cleaned.length <= limit) return cleaned
  return `…\n${cleaned.slice(-limit)}`
}

export function scrub(text: string, secret: string): string {
  if (secret.length >= 4 && text.includes(secret)) return text.replaceAll(secret, '***')
  return text
}

export function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const mark = part.indexOf('=')
    if (mark <= 0) continue
    labels[part.slice(0, mark).trim()] = part.slice(mark + 1).trim()
  }
  return labels
}

export function parsePs(output: string): ParsedContainer[] {
  const rows: ParsedContainer[] = []
  const lines = output.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') continue
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch (cause) {
      throw new ParseError(`第 ${index + 1} 行不是 JSON`, { cause })
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ParseError(`第 ${index + 1} 行不是容器记录`)
    }
    rows.push(containerFrom(payload as Record<string, unknown>))
  }
  return rows
}

export function parseDockerVersion(output: string): string {
  let payload: unknown
  try {
    payload = JSON.parse(output)
  } catch (cause) {
    throw new ParseError('无法解析 Docker 版本', { cause })
  }
  if (payload === null || typeof payload !== 'object') throw new ParseError('无法解析 Docker 版本')
  const record = payload as Record<string, unknown>
  const server = record.Server
  const client = record.Client
  const version = nestedVersion(server) || nestedVersion(client)
  if (version === '') throw new ParseError('Docker 版本输出里没有 Version')
  return version.slice(0, 64)
}

export function parseComposeVersion(output: string): string {
  const text = output.trim()
  if (text === '') throw new ParseError('没有读到 Docker Compose 版本')
  if (text.startsWith('{')) {
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (cause) {
      throw new ParseError('无法解析 Compose 版本', { cause })
    }
    if (payload === null || typeof payload !== 'object') throw new ParseError('无法解析 Compose 版本')
    const record = payload as Record<string, unknown>
    const version = String(record.version || record.short || '')
    if (version === '') throw new ParseError('Compose 版本输出里没有 version')
    return version.slice(0, 64)
  }
  const token = text.split(/\s+/).at(-1) ?? ''
  return token.slice(0, 64)
}

export function dockerAccessMessage(stderr: string): string | undefined {
  const lowered = stderr.toLowerCase()
  if (lowered.includes('permission denied') && lowered.includes('docker')) {
    return 'SSH 用户不能访问 Docker。把该用户加入 docker 组后重新测试连接。'
  }
  if (lowered.includes('command not found') && lowered.includes('docker')) {
    return '这台机器上没有 docker 命令。需要先安装 Docker Engine 和 Compose 插件。'
  }
  return undefined
}

export interface MetricSample {
  cpuCores: number
  cpuPercent: number
  memTotalBytes: number
  memUsedBytes: number
  diskTotalBytes: number
  diskUsedBytes: number
}

export function parseSample(text: string): MetricSample {
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 9) throw new ParseError('采集结果无法解析')
  const [cores, aTotal, aIdle, bTotal, bIdle, memTotalKb, memAvailKb, diskTotal, diskUsed] = parts.map(
    (part) => Number(part),
  )
  if (
    [cores, aTotal, aIdle, bTotal, bIdle, memTotalKb, memAvailKb, diskTotal, diskUsed].some(
      (item) => !Number.isFinite(item),
    )
  ) {
    throw new ParseError('采集结果无法解析')
  }
  if ((cores ?? 0) < 1 || (memTotalKb ?? 0) < 1 || (diskTotal ?? 0) < 1)
    throw new ParseError('采集结果无法解析')
  const delta = (bTotal ?? 0) - (aTotal ?? 0)
  const idle = (bIdle ?? 0) - (aIdle ?? 0)
  const cpu = delta <= 0 ? 0 : Math.round((100 * (delta - idle)) / delta)
  const memTotal = (memTotalKb ?? 0) * 1024
  const memUsed = Math.max(0, ((memTotalKb ?? 0) - (memAvailKb ?? 0)) * 1024)
  return {
    cpuCores: cores ?? 0,
    cpuPercent: Math.max(0, Math.min(100, cpu)),
    memTotalBytes: memTotal,
    memUsedBytes: Math.min(memUsed, memTotal),
    diskTotalBytes: diskTotal ?? 0,
    diskUsedBytes: Math.max(0, Math.min(diskUsed ?? 0, diskTotal ?? 0)),
  }
}

function nestedVersion(value: unknown): string {
  if (value === null || typeof value !== 'object') return ''
  const version = (value as Record<string, unknown>).Version
  return typeof version === 'string' ? version : ''
}

function containerFrom(payload: Record<string, unknown>): ParsedContainer {
  const containerId = String(payload.ID ?? '').trim()
  if (containerId === '') throw new ParseError('容器记录缺少 ID')
  const rawName =
    String(payload.Names ?? '')
      .split(',')[0]
      ?.trim() ?? ''
  const name = rawName.replace(/^\//, '') || containerId.slice(0, 12)
  const labels = parseLabels(String(payload.Labels ?? ''))
  const managedValue = (labels['smp.managed'] ?? '').toLowerCase()
  return {
    containerId,
    name,
    image: String(payload.Image ?? ''),
    status: String(payload.State || payload.Status || 'unknown').trim(),
    ports: String(payload.Ports ?? ''),
    managed: managedValue === 'true' || managedValue === '1' || managedValue === 'yes',
    strategySlug: labels['smp.strategy'] || null,
  }
}

/** Sanitize string leaves before JSON encoding so quoted or multiline secrets are also removed. */
export function scrubValue<T>(value: T, secret: string): T {
  const visit = (item: unknown): unknown =>
    typeof item === 'string'
      ? scrub(item, secret)
      : Array.isArray(item)
        ? item.map(visit)
        : item !== null && typeof item === 'object'
          ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]))
          : item
  return visit(value) as T
}
