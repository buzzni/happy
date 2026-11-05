/**
 * Which daemon home owns the machine-wide browser bridge (fixed port 41777).
 *
 * Chrome starts the native host without the daemon's environment, so it only
 * knows the documented homes. A Desktop-managed daemon lives elsewhere
 * (machine-links), so the daemon that binds the bridge records its home next
 * to the bridge token, the one place both sides already share. Imports nothing
 * global: the native host's stdout must stay protocol-only.
 */

import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

function ownerFile(userHome: string): string {
    return path.join(userHome, '.happy', 'browser-bridge.owner.json')
}

export async function writeBrowserBridgeOwnerHome(userHome: string, home: string): Promise<void> {
    const file = ownerFile(userHome)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ version: 1, home })) } finally { await handle.close() }
    await rename(temporary, file)
}

/** A missing or malformed record is only absent; the documented homes are still tried. */
export async function readBrowserBridgeOwnerHome(userHome: string): Promise<string | null> {
    try {
        const value = JSON.parse(await readFile(ownerFile(userHome), 'utf8'))
        return value?.version === 1 && typeof value.home === 'string' && path.isAbsolute(value.home) ? value.home : null
    } catch { return null }
}

/** The bridge owner first; a stale record just fails over to the documented personal/Standalone homes. */
export function browserSetupHomes({ userHome, happyHomeDir, ownerHome }: {
    userHome: string
    happyHomeDir: string
    ownerHome: string | null
}): string[] {
    return [...new Set([...(ownerHome ? [ownerHome] : []), happyHomeDir, path.join(userHome, '.happy_local'), path.join(userHome, '.happy_local_dev')])]
}
