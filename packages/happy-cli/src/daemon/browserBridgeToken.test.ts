import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readOrCreateBrowserBridgeToken, resolveBrowserBridgeTokenFile } from './browserBridgeToken'

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

    it('creates the containing directory when it does not exist yet', async () => {
        const nested = path.join(dir, 'fresh-home', '.happy', 'browser-bridge.token')
        const token = await readOrCreateBrowserBridgeToken(nested)
        expect(readFileSync(nested, 'utf8').trim()).toBe(token)
    })

    it('adopts the legacy token instead of minting a new one', async () => {
        const legacy = path.join(dir, 'legacy.token')
        writeFileSync(legacy, 'abc123\n')
        const token = await readOrCreateBrowserBridgeToken(filePath, { migrateFrom: legacy })
        expect(token).toBe('abc123')
        expect(readFileSync(filePath, 'utf8').trim()).toBe('abc123')
    })

    it('keeps the shared token when one already exists, ignoring the legacy file', async () => {
        writeFileSync(filePath, 'shared\n')
        const legacy = path.join(dir, 'legacy.token')
        writeFileSync(legacy, 'legacy\n')
        expect(await readOrCreateBrowserBridgeToken(filePath, { migrateFrom: legacy })).toBe('shared')
    })

    it('mints a token when the legacy file is absent', async () => {
        const token = await readOrCreateBrowserBridgeToken(filePath, { migrateFrom: path.join(dir, 'nope.token') })
        expect(token).toMatch(/^[0-9a-f]{64}$/)
        expect(existsSync(filePath)).toBe(true)
    })
})

/**
 * The bridge listener binds a fixed port (41777), so a machine has at most one
 * bridge — but the token used to live under HAPPY_HOME_DIR. `happy browser`
 * run in a plain shell then printed a different token than the daemon (started
 * with HAPPY_HOME_DIR set) was validating, and pairing could never succeed.
 */
describe('resolveBrowserBridgeTokenFile', () => {
    it('is machine-wide: the same path regardless of HAPPY_HOME_DIR', () => {
        const withEnv = resolveBrowserBridgeTokenFile({ homeDir: '/home/u', happyHomeDir: '/home/u/.happy_remote' })
        const withoutEnv = resolveBrowserBridgeTokenFile({ homeDir: '/home/u', happyHomeDir: '/home/u/.happy' })
        expect(withEnv.tokenFile).toBe(path.join('/home/u', '.happy', 'browser-bridge.token'))
        expect(withoutEnv.tokenFile).toBe(withEnv.tokenFile)
    })

    it('offers the home-dir-scoped file as the migration source', () => {
        const resolved = resolveBrowserBridgeTokenFile({ homeDir: '/home/u', happyHomeDir: '/home/u/.happy_remote' })
        expect(resolved.migrateFrom).toBe(path.join('/home/u/.happy_remote', 'browser-bridge.token'))
    })

    it('has nothing to migrate when the happy home dir is already the shared one', () => {
        const resolved = resolveBrowserBridgeTokenFile({ homeDir: '/home/u', happyHomeDir: '/home/u/.happy' })
        expect(resolved.migrateFrom).toBeNull()
    })
})
