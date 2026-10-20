import { Panel } from '@smp/console-kit'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import xtermCss from '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { ServerError } from '../../../shared/errors.ts'
import { displayError, serverCopy } from '../../../shared/i18n.ts'

const THEME = {
  background: '#1e1e1e',
  foreground: '#f2f3f5',
  cursor: '#f2f3f5',
  selectionBackground: '#264f78',
} as const

export function ServerTerminal(props: {
  active: string
  id: string
  onBack: () => void
  embedded?: boolean
}) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [error, setError] = useState<ServerError | null>(null)
  const [started, setStarted] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@smp/console-server-management/xterm'
    style.textContent = xtermCss
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    setError(null)
    setStarted(false)
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: THEME,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(
      `${proto}//${location.host}/console-api/servers/terminal?id=${encodeURIComponent(props.id)}`,
    )
    socket.binaryType = 'arraybuffer'
    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
    }
    const resize = terminal.onResize(() => {
      sendResize()
    })
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    })
    const observe = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        // The host can be between layout passes while a panel is opening.
      }
      sendResize()
    })
    observe.observe(host)
    socket.addEventListener('open', () => {
      try {
        fit.fit()
      } catch {
        // A zero-sized host is ignored; the observer reports the next size.
      }
      terminal.focus()
      sendResize()
    })
    socket.onmessage = (event) => {
      setStarted(true)
      if (typeof event.data === 'string') terminal.write(event.data)
      else terminal.write(new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onerror = () => {
      setError(new ServerError('terminal_failed'))
    }
    return () => {
      observe.disconnect()
      resize.dispose()
      input.dispose()
      socket.close()
      terminal.dispose()
    }
  }, [props.id])

  return (
    <Panel
      title={copy.terminal}
      className={props.embedded ? 'smp-server-terminal-panel' : undefined}
      extra={
        props.embedded ? undefined : (
          <button className="link" type="button" onClick={props.onBack}>
            {copy.back}
          </button>
        )
      }
    >
      {error !== null ? <p className="banner error">{displayError(active, error)}</p> : null}
      <div className="terminal-page">
        <div ref={hostRef} className="terminal-host" />
        {!started && <span className="terminal-hint">{copy.terminalHint}</span>}
      </div>
    </Panel>
  )
}
