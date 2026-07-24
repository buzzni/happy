import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readOrCreateBrowserBridgeToken } from './browserBridgeToken'

describe('readOrCreateBrowserBridgeToken', () => {
    let dir: string
    let filePath: string

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'bridge-token-'))
        filePath = path.join(dir, 'browser-bridge.token')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('creates a random 64-hex-char token when the file is missing', async () => {
        const token = await readOrCreateBrowserBridgeToken(filePath)
        expect(token).toMatch(/^[0-9a-f]{64}$/)
        expect(readFileSync(filePath, 'utf8').trim()).toBe(token)
    })

    it('returns the existing token on subsequent calls', async () => {
        const first = await readOrCreateBrowserBridgeToken(filePath)
        const second = await readOrCreateBrowserBridgeToken(filePath)
        expect(second).toBe(first)
    })

    it('restricts the token file to owner read/write (0600)', async () => {
        await readOrCreateBrowserBridgeToken(filePath)
        const mode = statSync(filePath).mode & 0o777
        expect(mode).toBe(0o600)
    })
})
