import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Panel } from '@smp/console-kit'
import { shellCopy } from './copy.ts'
import { applySiteChrome } from './site-chrome.ts'
import { DEFAULT_TITLE, siteDraft } from './site.ts'

interface LocaleChoice {
  id: string
  label: string
}

export interface LocaleFace {
  getSnapshot(): { active: string; locales: readonly LocaleChoice[] }
  subscribe(listener: () => void): () => void
  setLocale(id: string): void
}

export interface ThemeFace {
  getTheme(): { preference: string }
  setTheme(id: string): void
  subscribe(listener: () => void): () => void
}

export function GeneralView(props: { locale: LocaleFace; theme: ThemeFace }) {
  const locale = useSyncExternalStore(listener => props.locale.subscribe(listener), () => props.locale.getSnapshot())
  const theme = useSyncExternalStore(listener => props.theme.subscribe(listener), () => props.theme.getTheme())
  const copy = shellCopy(locale.active)
  const themes = [
    { id: 'light', label: copy.light },
    { id: 'dark', label: copy.dark },
    { id: 'system', label: copy.system },
  ]
  return (
    <>
      <Panel title={copy.language}>
        <div className="choice-row">
          {locale.locales.map(choice => (
            <button
              key={choice.id}
              className={choice.id === locale.active ? 'primary' : 'secondary'}
              type="button"
              aria-pressed={choice.id === locale.active}
              onClick={() => props.locale.setLocale(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </Panel>
      <Panel title={copy.appearance}>
        <div className="choice-row">
          {themes.map(choice => (
            <button
              key={choice.id}
              className={choice.id === theme.preference ? 'primary' : 'secondary'}
              type="button"
              aria-pressed={choice.id === theme.preference}
              onClick={() => props.theme.setTheme(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </Panel>
      <SitePanel copy={copy} />
    </>
  )
}

function SitePanel(props: { copy: ReturnType<typeof shellCopy> }) {
  const { copy } = props
  const [title, setTitle] = useState(DEFAULT_TITLE)
  const [icon, setIcon] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    void fetch('/console-api/site', { credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok || stopped) return
        const body = await response.json() as { title?: unknown; icon?: unknown }
        if (stopped) return
        if (typeof body.title === 'string' && body.title !== '') setTitle(body.title)
        if (typeof body.icon === 'string') setIcon(body.icon)
      })
      .catch((cause: unknown) => { void cause })
    return () => { stopped = true }
  }, [])

  function onIcon(event: { target: HTMLInputElement }): void {
    const file = event.target.files?.[0]
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      const draft = siteDraft({ title, icon: value })
      if (!draft.ok) {
        setError(draft.error === 'title' ? copy.titleInvalid : copy.iconInvalid)
        return
      }
      setIcon(draft.icon)
      setError('')
      setMessage('')
    }
    reader.readAsDataURL(file)
  }

  function save(event: FormEvent): void {
    event.preventDefault()
    const draft = siteDraft({ title, icon })
    if (!draft.ok) {
      setError(draft.error === 'title' ? copy.titleInvalid : copy.iconInvalid)
      setMessage('')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    void fetch('/console-api/site', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: draft.title, icon: draft.icon }),
    }).then(async response => {
      const payload = await response.json().catch(() => ({})) as { detail?: unknown; title?: unknown; icon?: unknown }
      if (!response.ok) {
        setError(typeof payload.detail === 'string' ? payload.detail : copy.requestFailed)
        return
      }
      const nextTitle = typeof payload.title === 'string' && payload.title !== '' ? payload.title : DEFAULT_TITLE
      const nextIcon = typeof payload.icon === 'string' ? payload.icon : ''
      setTitle(nextTitle)
      setIcon(nextIcon)
      applySiteChrome(nextTitle, nextIcon)
      setMessage(copy.siteSaved)
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : copy.requestFailed)
    }).finally(() => { setBusy(false) })
  }

  return (
    <Panel title={copy.site}>
      {error !== '' && <p className="banner error">{error}</p>}
      {message !== '' && <p className="banner ok">{message}</p>}
      <form className="panel-form" onSubmit={save}>
        <label>
          {copy.siteTitle}
          <input aria-label={copy.siteTitle} value={title} maxLength={80} onChange={event => setTitle(event.target.value)} />
        </label>
        <label>
          {copy.siteIcon}
          <input aria-label={copy.siteIcon} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onIcon} />
        </label>
        <p className="row">
          <img src={icon === '' ? '/favicon.svg' : icon} alt="" width={32} height={32} />
          <span className="muted">{copy.siteIconHint}</span>
        </p>
        <p className="row">
          {icon !== '' && (
            <button
              className="secondary"
              type="button"
              onClick={() => { setIcon(''); setMessage(''); setError('') }}
            >
              {copy.siteIconDefault}
            </button>
          )}
          <button className="primary" type="submit" disabled={busy}>{copy.save}</button>
        </p>
      </form>
    </Panel>
  )
}
