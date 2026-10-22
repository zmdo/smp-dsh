import { useEffect, useRef, useState } from 'react'
import type { ExecLimitsSettings } from '../../shared/dto/settings.ts'
import { displayError, serverCopy, type LocaleFace } from '../../shared/i18n.ts'
import { api, requestError } from '../shared/api.ts'
import { useActiveLocale } from '../shared/locale.ts'

const FIELDS = [
  ['defaultTimeoutMs', 'maxTimeoutMs'],
  ['defaultCommandBytes', 'maxCommandBytes'],
  ['defaultOutputBytes', 'maxOutputBytes'],
] as const

export function ExecutionSettings(props: { locale: LocaleFace }) {
  const active = useActiveLocale(props.locale)
  const c = serverCopy(active).ui
  const [form, setForm] = useState<ExecLimitsSettings>()
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const version = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    void api<ExecLimitsSettings>('/console-api/server-management-settings', { signal: controller.signal })
      .then(setForm)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause) })
    return () => controller.abort()
  }, [])
  const change = (key: keyof ExecLimitsSettings, value: number) => {
    version.current += 1
    setSaved(false)
    setDirty(true)
    setError(null)
    setForm((current) => current === undefined ? current : { ...current, [key]: value })
  }
  useEffect(() => {
    if (!dirty || form === undefined || saving) return
    const versionAtSave = version.current
    const timer = setTimeout(() => {
      setSaving(true)
      setError(null)
      void api<ExecLimitsSettings>('/console-api/server-management-settings', {
        method: 'PUT',
        body: JSON.stringify(form),
      })
        .then((next) => {
          if (version.current === versionAtSave) {
            setForm(next)
            setDirty(false)
            setSaved(true)
          }
        })
        .catch((cause: unknown) => {
          setDirty(false)
          setError(cause)
        })
        .finally(() => setSaving(false))
    }, 500)
    return () => clearTimeout(timer)
  }, [dirty, form, saving])
  if (error !== null && form === undefined)
    return <p className="banner error" role="alert">{displayError(active, requestError(error))}</p>
  if (form === undefined) return <p className="muted">{c.settingsLoading}</p>
  return (
    <form className="smp-server-exec-settings" onSubmit={(event) => event.preventDefault()}>
      <header>
        <h2>{c.settingsServer}</h2>
        <p className="muted">{c.settingsHint}</p>
      </header>
      {FIELDS.map(([defaultKey, maxKey]) => (
        <section key={defaultKey} className="smp-server-exec-limit">
          <h3>{c[`${defaultKey}Label` as keyof typeof c] ?? defaultKey}</h3>
          <label>
            {c.settingsDefault}
            <input
              type="number"
              min={1}
              value={form[defaultKey]}
              onChange={(event) => change(defaultKey, Number(event.target.value))}
            />
          </label>
          <label>
            {c.settingsMaximum}
            <input
              type="number"
              min={1}
              value={form[maxKey]}
              onChange={(event) => change(maxKey, Number(event.target.value))}
            />
          </label>
        </section>
      ))}
      {error !== null && <p className="banner error" role="alert">{displayError(active, requestError(error))}</p>}
      {saved && !dirty && <p className="banner success" role="status">{c.settingsSaved}</p>}
      {saving && <p className="muted" role="status">{c.settingsSaving}</p>}
    </form>
  )
}
