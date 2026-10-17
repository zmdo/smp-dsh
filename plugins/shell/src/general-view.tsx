import { useSyncExternalStore } from 'react'

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

const THEMES = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
] as const

export function GeneralView(props: { locale: LocaleFace; theme: ThemeFace }) {
  const locale = useSyncExternalStore(listener => props.locale.subscribe(listener), () => props.locale.getSnapshot())
  const theme = useSyncExternalStore(listener => props.theme.subscribe(listener), () => props.theme.getTheme())
  return (
    <>
      <section className="panel">
        <header className="panel-head"><h1><i className="mark" />语言</h1></header>
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
        <header className="panel-head"><h1><i className="mark" />外观</h1></header>
        <div className="panel-body">
          <div className="choice-row">
            {THEMES.map(choice => (
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
