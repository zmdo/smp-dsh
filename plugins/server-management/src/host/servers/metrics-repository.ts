import type { Db } from '../db.ts'
import { type MetricSample } from '../remote/parse.ts'

export async function saveMetrics(
  db: Db,
  serverId: string,
  sample: MetricSample,
  configRevision: string | number,
): Promise<void> {
  await db.query(
    `update server_runtime r set cpu_cores=$2,cpu_percent=$3,memory_total_bytes=$4,memory_used_bytes=$5,disk_total_bytes=$6,disk_used_bytes=$7,metrics_sampled_at=now(),metrics_error=null
    from servers s where r.server_id=s.id and s.id=$1 and s.config_revision=$8`,
    [
      serverId,
      sample.cpuCores,
      sample.cpuPercent,
      sample.memTotalBytes,
      sample.memUsedBytes,
      sample.diskTotalBytes,
      sample.diskUsedBytes,
      configRevision,
    ],
  )
}

export async function serverIds(db: Db): Promise<string[]> {
  const result = await db.query<{
    id: string
  }>(`select s.id from servers s join server_runtime r on r.server_id=s.id
    where r.os_probe_state='detected' and r.detected_os->>'family' <> 'builtin/windows-server' and r.observed_config_revision=s.config_revision`)
  return result.rows.map((row) => row.id)
}
