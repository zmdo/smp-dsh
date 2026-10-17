import { useSyncExternalStore } from 'react'
import { shellCopy } from './copy.ts'

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
      <section className="panel">
        <header className="panel-head"><h1><i className="mark" />{copy.language}</h1></header>
        <div className="panel-body">
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
        </div>
      </section>
      <section className="panel">
        <header className="panel-head"><h1><i className="mark" />{copy.appearance}</h1></header>
        <div className="panel-body">
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
        </div>
      </section>
    </>
  )
}
