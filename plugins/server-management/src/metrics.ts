import { parseSample } from './parse.ts'
import { connectSsh, type SshSession } from './ssh.ts'
import { saveMetrics, serverIds, serverSecret, type Db } from './store.ts'

const SAMPLE = `cores=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo)
read_cpu() { awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print t, idle}' /proc/stat; }
a=$(read_cpu)
sleep 1
b=$(read_cpu)
mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
disk_total=$(df -B1 -P / | awk 'NR==2 {print $2}')
disk_used=$(df -B1 -P / | awk 'NR==2 {print $3}')
printf '%s %s %s %s %s %s %s\\n' "$cores" "$a" "$b" "$mem_total" "$mem_avail" "$disk_total" "$disk_used"
`

const RETRY_MS = 3000

interface Secrets {
  decrypt(ciphertext: string): string
}

/** One SSH per server. A dropped connection waits a few seconds and does not mark the server offline. */
export function startMetrics(db: Db, secrets: Secrets, intervalSeconds: number, onError: (cause: unknown) => void, connect: typeof connectSsh = connectSsh): () => Promise<void> {
  const sessions = new Map<string, SshSession>()
  const retryAt = new Map<string, number>()
  const busy = new Set<string>()
  const tasks = new Set<Promise<void>>()
  let stopped = false
  const timer = setInterval(() => {
    const task = sampleAll()
      .catch((cause: unknown) => { onError(cause) })
      .finally(() => { tasks.delete(task) })
    tasks.add(task)
  }, Math.max(1, intervalSeconds) * 1000)

  return async () => {
    stopped = true
    clearInterval(timer)
    for (const session of sessions.values()) session.close()
    sessions.clear()
    await Promise.all(tasks)
  }

  async function sampleAll(): Promise<void> {
    if (stopped) return
    const ids = await serverIds(db)
    if (stopped) return
    const live = new Set(ids)
    for (const [id, session] of sessions) {
      if (live.has(id)) continue
      session.close()
      sessions.delete(id)
      retryAt.delete(id)
    }
    await Promise.all(ids.map(id => sampleOne(id)))
  }

  async function sampleOne(id: string): Promise<void> {
    if (stopped || busy.has(id) || Date.now() < (retryAt.get(id) ?? 0)) return
    busy.add(id)
    let session = sessions.get(id)
    try {
      if (session === undefined) {
        session = await open(id)
        if (stopped) { session.close(); return }
        sessions.set(id, session)
      }
      const result = await session.exec(SAMPLE, 8000)
      if (stopped) return
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || '采集失败')
      await saveMetrics(db, id, parseSample(result.stdout))
    } catch (cause) {
      void cause
      session?.close()
      if (sessions.get(id) === session) sessions.delete(id)
      retryAt.set(id, Date.now() + RETRY_MS)
    } finally {
      busy.delete(id)
    }
  }

  async function open(id: string): Promise<SshSession> {
    const server = await serverSecret(db, id)
    if (server === undefined) throw new Error('服务器不存在')
    return connect({
      host: server.intranet_host,
      port: server.ssh_port,
      username: server.ssh_user,
      authMethod: server.auth_method,
      secret: secrets.decrypt(server.secret_ciphertext),
      expectedFingerprint: server.host_key_fingerprint,
    })
  }
}
