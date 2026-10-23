import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    buildDaemonIdentity,
    checkExecutableReplaced,
    readExecutableDigest,
    verifyDaemonIdentity,
    type DaemonIdentity,
} from './daemonIdentity'

function bundle(content: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'daemon-identity-')), 'index.mjs')
    writeFileSync(path, content)
    return path
}

describe('readExecutableDigest', () => {
    it('records path, size, mtime and sha256', () => {
        const path = bundle('console.log(1)')
        const digest = readExecutableDigest(path)
        expect(digest).toMatchObject({ path, size: 14 })
        expect(digest?.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(typeof digest?.mtimeMs).toBe('number')
    })

    it('is undefined when the bundle is missing', () => {
        expect(readExecutableDigest('/nonexistent/dist/index.mjs')).toBeUndefined()
    })
})

describe('checkExecutableReplaced (R18: same content reinstall is not a replacement)', () => {
    it('does not hash while size and mtime are unchanged', () => {
        const path = bundle('a')
        const baseline = readExecutableDigest(path)!
        const hash = vi.fn(() => 'never')
        expect(checkExecutableReplaced(baseline, { hash })).toEqual({ replaced: false, baseline })
        expect(hash).not.toHaveBeenCalled()
    })

    it('treats a rewrite with identical content as not replaced and moves the baseline', () => {
        const path = bundle('same')
        const baseline = readExecutableDigest(path)!
        writeFileSync(path, 'same')
        utimesSync(path, new Date(), new Date(Date.now() + 5_000))
        const result = checkExecutableReplaced(baseline)
        expect(result.replaced).toBe(false)
        expect(result.baseline.mtimeMs).not.toBe(baseline.mtimeMs)
        expect(result.baseline.sha256).toBe(baseline.sha256)
    })

    it('reports a replacement when the content differs', () => {
        const path = bundle('old')
        const baseline = readExecutableDigest(path)!
        writeFileSync(path, 'new bundle')
        expect(checkExecutableReplaced(baseline).replaced).toBe(true)
    })

    it('keeps the baseline when the file is temporarily missing', () => {
        const baseline = { path: '/nonexistent/x', size: 1, mtimeMs: 1, sha256: 'a'.repeat(64) }
        expect(checkExecutableReplaced(baseline)).toEqual({ replaced: false, baseline })
    })
})

describe('buildDaemonIdentity', () => {
    it('reads its own start time once and includes the boot id when known', () => {
        const startedAt = vi.fn(() => 1_000)
        expect(buildDaemonIdentity({
            pid: 42, readStartedAt: startedAt, readBootId: () => 'boot-a', executable: undefined,
        })).toEqual({ pid: 42, startedAt: 1_000, bootId: 'boot-a' })
        expect(startedAt).toHaveBeenCalledWith(42)
    })

    it('omits fields it could not read instead of inventing them', () => {
        expect(buildDaemonIdentity({
            pid: 42, readStartedAt: () => undefined, readBootId: () => undefined, executable: undefined,
        })).toEqual({ pid: 42 })
    })
})

describe('verifyDaemonIdentity (R19)', () => {
    const recorded: DaemonIdentity = { pid: 7, startedAt: 10_000, bootId: 'boot-a' }
    const deps = (overrides: Partial<Parameters<typeof verifyDaemonIdentity>[1]> = {}) => ({
        isPidAlive: () => true,
        readStartedAt: () => 10_400,
        readBootId: () => 'boot-a',
        platform: 'darwin' as NodeJS.Platform,
        ...overrides,
    })

    it('matches the same process within one second of start time', async () => {
        await expect(verifyDaemonIdentity(recorded, deps())).resolves.toBe('match')
    })

    it('is dead when the pid is gone', async () => {
        await expect(verifyDaemonIdentity(recorded, deps({ isPidAlive: () => false }))).resolves.toBe('dead')
    })

    it('is a different process when the pid was reused later', async () => {
        await expect(verifyDaemonIdentity(recorded, deps({ readStartedAt: () => 20_000 }))).resolves.toBe('mismatch')
    })

    it('is a different process after a reboot even if times look close', async () => {
        await expect(verifyDaemonIdentity(recorded, deps({ readBootId: () => 'boot-b' }))).resolves.toBe('mismatch')
    })

    it('requires an exact start time on Windows', async () => {
        await expect(verifyDaemonIdentity({ pid: 7, startedAt: 10_000 }, deps({ platform: 'win32', readStartedAt: () => 10_001 })))
            .resolves.toBe('mismatch')
        await expect(verifyDaemonIdentity({ pid: 7, startedAt: 10_000 }, deps({ platform: 'win32', readStartedAt: () => 10_000 })))
            .resolves.toBe('match')
    })

    it('cannot verify when the live start time is unreadable or the record has none', async () => {
        await expect(verifyDaemonIdentity(recorded, deps({ readStartedAt: () => undefined }))).resolves.toBe('unknown')
        await expect(verifyDaemonIdentity({ pid: 7 }, deps())).resolves.toBe('unknown')
    })
})
