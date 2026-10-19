import type { Component } from '../src/catalog.ts'

export function componentFixture(id: string, requires: string[] = []): Component {
  return {
    id, name: id, summary: '', order: 0, requires, directory: '', recipe: `builtin/${id}`,
    name_i18n: { zh: id, en: id }, summary_i18n: { zh: '', en: '' }, detection: id === 'docker' || id === 'compose' ? 'builtin' : 'json',
    detectScript: Buffer.from('printf \'{"state":"installed"}\'\n'), installScript: Buffer.from('exit 0\n'),
  }
}

export function builtinCatalog(): Component[] {
  return [componentFixture('docker'), componentFixture('compose', ['docker'])]
}
