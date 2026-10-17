import { randomBytes } from 'node:crypto'
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import {
  clearInstallDisabled,
  clearStoreCredentials,
  installDisabled,
  storeCredentials,
  writeInstallPatch,
  type StoreCredentials,
} from './patch.ts'

export const MARKER_NAME = 'install-complete'

export function markerPath(profileDir: string): string {
  return join(profileDir, MARKER_NAME)
}

export async function markerExists(profileDir: string): Promise<boolean> {
  try {
    await access(markerPath(profileDir))
    return true
  } catch (cause) {
    void cause
    return false
  }
}

export async function writeMarker(profileDir: string): Promise<void> {
  await writeFile(markerPath(profileDir), '', { mode: 0o600 })
}

export async function removeMarker(profileDir: string): Promise<void> {
  try {
    await unlink(markerPath(profileDir))
  } catch (cause) {
    const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    if (code !== 'ENOENT') throw cause
  }
}

export async function readPatch(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    if (code === 'ENOENT') return '[]\n'
    throw cause
  }
}

/** Replace the profile patch without logging its contents. */
export async function writePatch(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, contents.endsWith('\n') ? contents : `${contents}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export async function ensureDisabled(path: string): Promise<void> {
  const current = await readPatch(path)
  if (installDisabled(current)) return
  await writePatch(path, writeInstallPatch(current, { disable: true }))
}

export async function saveCredentials(path: string, credentials: StoreCredentials): Promise<string> {
  const current = await readPatch(path)
  const next = writeInstallPatch(current, { credentials, disable: true })
  await writePatch(path, next)
  return current
}

/** Reload the store plugin from the patch file just written. */
export async function reloadStore(ctx: Context, profile: ProfileFacts): Promise<void> {
  const patches = readProfilePatches('dsh', profile)
  await reconcileProfilePatches(ctx.root, patches, 'dsh', ['console-store'])
}

export interface ProfileFacts {
  dir: string
  patchPath: string
  home: string
  installAnchor: string
  overlays: readonly unknown[]
  telemetryDisabledEnv?: string
}

export { clearInstallDisabled, clearStoreCredentials, installDisabled, storeCredentials }
