import { useSyncExternalStore } from 'react'
import { Panel } from '@smp/console-kit'
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
    </>
  )
}
