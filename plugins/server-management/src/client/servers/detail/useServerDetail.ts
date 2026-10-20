import { useEffect, useState } from 'react'
import type { ServerRow } from '../../../shared/api.ts'
import { ServerError } from '../../../shared/errors.ts'
import { serverCopy } from '../../../shared/i18n.ts'
import { api, requestError } from '../../shared/api.ts'
import type { ServerDetailProps } from './types.ts'
export function useServerDetail(props: ServerDetailProps) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [server, setServer] = useState<ServerRow | undefined>()
  const [error, setError] = useState<ServerError | null>(null)
  const [moving, setMoving] = useState(false)
  const [queued, setQueued] = useState(false)
  const [taskRefresh, setTaskRefresh] = useState(0)

  useEffect(() => {
    let stopped = false
    const load = () => {
      void api<ServerRow>(`/console-api/servers/${props.id}`)
        .then((next) => {
          if (!stopped) setServer(next)
        })
        .catch((cause: unknown) => {
          if (!stopped) setError(requestError(cause))
        })
    }
    load()
    const timer = setInterval(load, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [props.id])

  async function act(path: string): Promise<void> {
    setError(null)
    setQueued(false)
    try {
      await api(path, { method: 'POST' })
      setQueued(true)
      setTaskRefresh((value) => value + 1)
    } catch (cause) {
      setError(requestError(cause))
    }
  }

  async function remove(): Promise<void> {
    try {
      await api(`/console-api/servers/${props.id}`, { method: 'DELETE' })
      props.onBack()
    } catch (cause) {
      setError(requestError(cause))
    }
  }

  return { active, copy, server, error, queued, taskRefresh, moving, setMoving, act, remove }
}
