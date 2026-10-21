import type { Db } from '../database/connection.ts'
import type { MetricHistoryDto, MetricPoint, MetricRange } from '../../shared/dto/metrics.ts'
import { readRawMetrics, readRollupMetrics, type RawMetricRow, type RollupMetricRow } from './persistence/history-repository.ts'

const RANGES: Record<MetricRange, { seconds: number; step: number; source: 'raw' | '5m' | '1h' }> = {
  '1h': { seconds: 3600, step: 60, source: 'raw' },
  '6h': { seconds: 6 * 3600, step: 60, source: 'raw' },
  '24h': { seconds: 24 * 3600, step: 300, source: 'raw' },
  '7d': { seconds: 7 * 24 * 3600, step: 900, source: '5m' },
  '30d': { seconds: 30 * 24 * 3600, step: 3600, source: '1h' },
}

interface Bucket {
  t: number
  cpu: number
  cpuMax: number
  memory: number
  memoryMax: number
  disk: number
  diskMax: number
  weight: number
}

export function metricRange(value: string | null): MetricRange | null {
  return value !== null && Object.hasOwn(RANGES, value) ? (value as MetricRange) : null
}

export async function metricHistory(
  db: Db,
  serverId: string,
  range: MetricRange,
): Promise<MetricHistoryDto> {
  const config = RANGES[range]
  let rows = await readSource(db, serverId, config.source, config.seconds)
  let resolution = config.source
  // A freshly started process may not have rolled up yet; raw data is still useful for shorter windows.
  if (rows.length === 0 && config.source !== 'raw') {
    rows = await readRaw(db, serverId, config.seconds)
    resolution = 'raw'
  }
  const buckets = new Map<number, Bucket>()
  for (const row of rows) {
    const t = new Date(row.t).getTime()
    const key = Math.floor(t / (config.step * 1000)) * config.step * 1000
    const current = buckets.get(key)
    const cpu = Number('cpu' in row ? row.cpu : row.cpu_avg)
    const memory = Number('memory' in row ? row.memory : row.memory_avg)
    const disk = Number('disk' in row ? row.disk : row.disk_avg)
    const samples = 'samples' in row ? row.samples : 1
    const cpuMax = Number('cpu' in row ? row.cpu : row.cpu_max)
    const memoryMax = Number('memory' in row ? row.memory : row.memory_max)
    const diskMax = Number('disk' in row ? row.disk : row.disk_max)
    if (current === undefined) {
      buckets.set(key, {
        t: key,
        cpu: cpu * samples,
        cpuMax,
        memory: memory * samples,
        memoryMax,
        disk: disk * samples,
        diskMax,
        weight: samples,
      })
      continue
    }
    current.cpu += cpu * samples
    current.memory += memory * samples
    current.disk += disk * samples
    current.weight += samples
    current.cpuMax = Math.max(current.cpuMax, cpuMax)
    current.memoryMax = Math.max(current.memoryMax, memoryMax)
    current.diskMax = Math.max(current.diskMax, diskMax)
  }
  const points: MetricPoint[] = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map((bucket) => ({
      t: new Date(bucket.t).toISOString(),
      cpu: round(bucket.cpu / bucket.weight),
      memory: round(bucket.memory / bucket.weight),
      disk: round(bucket.disk / bucket.weight),
      cpuMax: round(bucket.cpuMax),
      memoryMax: round(bucket.memoryMax),
      diskMax: round(bucket.diskMax),
    }))
  const last = points.at(-1)
  return {
    range,
    resolution,
    points,
    summary: last === undefined ? null : { cpu: last.cpu, memory: last.memory, disk: last.disk },
  }
}

async function readSource(
  db: Db,
  serverId: string,
  source: 'raw' | '5m' | '1h',
  seconds: number,
): Promise<(RawMetricRow | RollupMetricRow)[]> {
  if (source === 'raw') return readRawMetrics(db, serverId, seconds)
  return readRollupMetrics(db, serverId, source, seconds)
}

async function readRaw(db: Db, serverId: string, seconds: number): Promise<RawMetricRow[]> {
  return readRawMetrics(db, serverId, seconds)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
