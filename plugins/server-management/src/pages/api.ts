export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: init?.body === undefined ? init?.headers : { 'content-type': 'application/json', ...init.headers },
  })
  if (response.status === 204) return undefined as T
  const payload = await response.json().catch(() => ({})) as { detail?: unknown }
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : '请求没有完成')
  return payload as T
}
