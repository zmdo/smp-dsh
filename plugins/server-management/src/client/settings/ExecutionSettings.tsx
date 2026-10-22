import { useEffect, useState, type FormEvent } from 'react'
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
  useEffect(() => {
    const controller = new AbortController()
    void api<ExecLimitsSettings>('/console-api/server-management-settings', { signal: controller.signal })
      .then(setForm)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause) })
    return () => controller.abort()
  }, [])
  const change = (key: keyof ExecLimitsSettings, value: number) => {
    setSaved(false)
    setForm((current) => current === undefined ? current : { ...current, [key]: value })
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (form === undefined) return
    setSaving(true)
    setError(null)
    try {
      const next = await api<ExecLimitsSettings>('/console-api/server-management-settings', {
        method: 'PUT',
        body: JSON.stringify(form),
      })
      setForm(next)
      setSaved(true)
    } catch (cause) {
      setError(cause)
    } finally {
      setSaving(false)
    }
  }
  if (error !== null && form === undefined)
    return <p className="banner error" role="alert">{displayError(active, requestError(error))}</p>
  if (form === undefined) return <p className="muted">{c.settingsLoading}</p>
  return (
    <form className="smp-server-exec-settings" onSubmit={submit}>
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
      {saved && <p className="banner success" role="status">{c.settingsSaved}</p>}
      <footer>
        <button className="primary" type="submit" disabled={saving}>{saving ? c.settingsSaving : c.settingsSave}</button>
      </footer>
    </form>
  )
}
