import en from '../locale/en.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }
import { localized, type LocalizedText } from './definitions.ts'

export interface LocaleFace {
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

export type ErrorCode = keyof typeof en.errors
export type MessageParams = Readonly<Record<string, string | number>>

export function serverCopy(active: string) {
  return active === 'zh' ? zh : en
}

export function format(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(params[key] ?? match))
}

export function errorText(active: string, code: ErrorCode, params: MessageParams = {}): string {
  const message = format(serverCopy(active).errors[code], params)
  return typeof params.detail === 'string' && params.detail !== '' ? `${message} ${params.detail}` : message
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(en.errors, value)
}

/** Stable codes travel across HTTP; display text is resolved when the page renders. */
export class ServerError extends Error {
  readonly code: ErrorCode
  readonly params: MessageParams

  constructor(code: ErrorCode, params: MessageParams = {}, options?: ErrorOptions) {
    super(errorText('zh', code, params), options)
    this.name = 'ServerError'
    this.code = code
    this.params = params
  }
}

export function errorPayload(error: ServerError) {
  return { code: error.code, params: error.params, detail: error.message }
}

export function formatDate(value: string | null, active: string): string {
  if (value === null || value === '') return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(active === 'zh' ? 'zh-CN' : 'en-US')
}

export function enumLabel(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? labels[value]! : value
}

export function componentText(active: string, component: { id: string; name: string; summary: string; name_i18n?: LocalizedText; summary_i18n?: LocalizedText }) {
  if (component.name_i18n !== undefined) return { name: localized(component.name_i18n, active), summary: component.summary_i18n === undefined ? component.summary : localized(component.summary_i18n, active) }
  const labels = serverCopy(active).components
  return Object.hasOwn(labels, component.id) ? labels[component.id as keyof typeof labels] : component
}

export function componentName(active: string, id: string): string {
  return componentText(active, { id, name: id, summary: '' }).name
}

export function groupName(active: string, group: { name: string; name_i18n?: LocalizedText | null }): string {
  return group.name_i18n == null ? group.name : localized(group.name_i18n, active)
}
