/**
 * Pairing token for the Chrome extension bridge. The user copies this token
 * into the extension's options page; the daemon rejects WS connections that
 * don't present it (browserBridge.ts).
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

export async function readOrCreateBrowserBridgeToken(filePath: string): Promise<string> {
    try {
        const existing = (await readFile(filePath, 'utf8')).trim()
        if (existing) return existing
    } catch {
        // fall through to create
    }
    const token = randomBytes(32).toString('hex')
    await writeFile(filePath, token + '\n', { mode: 0o600 })
    return token
}
