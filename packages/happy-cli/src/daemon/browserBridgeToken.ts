/**
 * Pairing token for the Chrome extension bridge. The user copies this token
 * into the extension's options page; the daemon rejects WS connections that
 * don't present it (browserBridge.ts).
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Where the token lives — deliberately NOT under HAPPY_HOME_DIR.
 *
 * The bridge listener binds a fixed port (41777), so a machine has at most one
 * bridge no matter how many installs are configured. Scoping the credential
 * per install while the resource it guards is machine-wide produced a real,
 * undiagnosable outage: a daemon started with HAPPY_HOME_DIR set validated one
 * token while `happy browser` in a plain shell printed another, so the user's
 * extension was rejected forever (4401) while a stale one held the bridge.
 * `migrateFrom` lets an install that already paired keep its token.
 */
export function resolveBrowserBridgeTokenFile({ homeDir, happyHomeDir }: {
    homeDir: string
    happyHomeDir: string
}): { tokenFile: string; migrateFrom: string | null } {
    const tokenFile = path.join(homeDir, '.happy', 'browser-bridge.token')
    const legacy = path.join(happyHomeDir, 'browser-bridge.token')
    return { tokenFile, migrateFrom: legacy === tokenFile ? null : legacy }
}

export async function readOrCreateBrowserBridgeToken(
    filePath: string,
    opts: { migrateFrom?: string | null } = {},
): Promise<string> {
    const existing = await readToken(filePath)
    if (existing) return existing

    // Adopting the old per-install token keeps an already-paired extension
    // working across this change; only a machine that never paired gets a
    // freshly minted one.
    const inherited = opts.migrateFrom ? await readToken(opts.migrateFrom) : null
    const token = inherited ?? randomBytes(32).toString('hex')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, token + '\n', { mode: 0o600 })
    return token
}

async function readToken(filePath: string): Promise<string | null> {
    try {
        const contents = (await readFile(filePath, 'utf8')).trim()
        return contents || null
    } catch {
        return null
    }
}
