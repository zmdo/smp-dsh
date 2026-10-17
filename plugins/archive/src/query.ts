export type SessionSearchBy = 'title' | 'id'

export interface SessionSearchRow {
  id: string
  title: string
}

/** Empty text keeps every row. Title and id are separate, case-insensitive substrings. */
export function sessionMatches(row: SessionSearchRow, by: SessionSearchBy, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  const haystack = by === 'id' ? row.id : row.title
  return haystack.toLowerCase().includes(needle)
}

export function sessionIdError(id: string): string | undefined {
  if (id === '' || /\s/.test(id) || id.length > 200) return '会话编号不对'
  return undefined
}
