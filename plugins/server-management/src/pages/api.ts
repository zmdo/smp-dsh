import { ServerError, componentName, errorText, isErrorCode } from '../i18n.ts'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: init?.body === undefined ? init?.headers : { 'content-type': 'application/json', ...init.headers },
  })
  if (response.status === 204) return undefined as T
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) throw responseError(payload)
  return payload as T
}

export function responseError(payload: unknown): ServerError {
  if (typeof payload !== 'object' || payload === null) return new ServerError('request_failed')
  const { code, params, detail } = payload as { code?: unknown; params?: unknown; detail?: unknown }
  if (isErrorCode(code)) {
    const values: Record<string, string | number> = {}
    if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' || typeof value === 'number') values[key] = value
      }
    }
    return new ServerError(code, values)
  }
  return new ServerError('request_failed', typeof detail === 'string' ? { detail } : {})
}

export function requestError(cause: unknown): ServerError {
  if (cause instanceof ServerError) return cause
  return new ServerError('request_failed', cause instanceof Error ? { detail: cause.message } : {}, { cause })
}

export function displayError(active: string, error: ServerError | null): string {
  if (error === null) return ''
  const params = { ...error.params }
  if (error.code === 'component_dependency') {
    if (typeof params.component === 'string') params.component = componentName(active, params.component)
    if (typeof params.dependency === 'string') params.dependency = componentName(active, params.dependency)
  }
  return errorText(active, error.code, params)
}
