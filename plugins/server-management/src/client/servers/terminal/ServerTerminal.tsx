import { Panel } from '@smp/console-kit'
import { useEffect, useState } from 'react'
import { ServerError } from '../../../shared/errors.ts'
import { displayError, serverCopy } from '../../../shared/i18n.ts'
export function ServerTerminal(props: { active: string; id: string; onBack: () => void }) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [text, setText] = useState('')
  const [error, setError] = useState<ServerError | null>(null)
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(
      `${proto}//${location.host}/console-api/servers/terminal?id=${encodeURIComponent(props.id)}`,
    )
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (event) => {
      const chunk =
        typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
      setText((current) => `${current}${chunk}`.slice(-20000))
    }
    socket.onerror = () => {
      setError(new ServerError('terminal_failed'))
    }
    const host = document.querySelector<HTMLElement>('.terminal-host')
    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN || host === null) return
      const cols = Math.min(300, Math.max(20, Math.floor(host.clientWidth / 8)))
      const rows = Math.min(120, Math.max(5, Math.floor(host.clientHeight / 18)))
      socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
    const onKey = (event: KeyboardEvent) => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('terminal-host')) return
      event.preventDefault()
      const key =
        event.key === 'Enter'
          ? '\r'
          : event.key === 'Backspace'
            ? '\u007f'
            : event.key === 'Tab'
              ? '\t'
              : event.key.length === 1
                ? event.key
                : ''
      if (key !== '') socket.send(key)
    }
    host?.addEventListener('keydown', onKey)
    socket.addEventListener('open', sendResize)
    const observer = new ResizeObserver(sendResize)
    if (host !== null) observer.observe(host)
    return () => {
      observer.disconnect()
      host?.removeEventListener('keydown', onKey)
      socket.close()
    }
  }, [props.id])
  return (
    <Panel
      title={copy.terminal}
      extra={
        <button className="link" type="button" onClick={props.onBack}>
          {copy.back}
        </button>
      }
    >
      {error !== null ? <p className="banner error">{displayError(active, error)}</p> : null}
      <div className="terminal-page">
        <pre
          className="terminal-host"
          tabIndex={0}
          style={{ color: '#f2f3f5', whiteSpace: 'pre-wrap', margin: 0 }}
        >
          {text || copy.terminalHint}
        </pre>
      </div>
    </Panel>
  )
}
