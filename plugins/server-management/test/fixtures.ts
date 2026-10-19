import { APT_SOFTWARE_OS } from '../src/operating-systems.ts'
import type { Component } from '../src/catalog.ts'

export function componentFixture(id: string, requires: string[] = []): Component {
  return {
    id, software_key:id==='docker'?'builtin/docker-engine':id==='compose'?'builtin/docker-compose':`test/${id}`, supportedOs:APT_SOFTWARE_OS, name: id, summary: '', order: 0, requires, directory: '', recipe: `builtin/${id}`,
    name_i18n: { zh: id, en: id }, summary_i18n: { zh: '', en: '' }, detection: id === 'docker' || id === 'compose' ? 'builtin' : 'json',
    detectScript: Buffer.from('printf \'{"state":"installed","version":"1.0.0"}\'\n'), installScript: Buffer.from('exit 0\n'),
  }
}

export function builtinCatalog(): Component[] {
  return [componentFixture('docker'), componentFixture('compose', ['docker'])]
}
