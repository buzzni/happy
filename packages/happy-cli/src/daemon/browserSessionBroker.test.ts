import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserSessionBroker } from './browserSessionBroker'

const A = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const B = 'bv1_abcdefghijklmnopqrstuvwxyz012346'

function runtime() {
    return {
        ensure: vi.fn(async (viewerKey: string) => ({
            webPort: viewerKey === A ? 49100 : 49101,
            profileVolume: `volume-${viewerKey}`,
            reused: false,
        })),
        lookup: vi.fn(async (viewerKey: string): Promise<{ webPort: number; profileVolume: string } | null> => ({
            webPort: viewerKey === A ? 49100 : 49101,
            profileVolume: `volume-${viewerKey}`,
        })),
        stop: vi.fn(async (_viewerKey: string) => true),
        listManaged: vi.fn(async () => []),
        migrateLegacyProfile: vi.fn(async () => undefined),
        profileBytes: vi.fn(async (_viewerKey: string) => 0),
    }
}

describe('BrowserSessionBroker', () => {
    it('reuses one lease, enforces capacity, and never evicts another user', async () => {
        const docker = runtime()
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 1, now: () => 1_000 })

        const first = await broker.ensure(A, 'scoped-token-value')
        const again = await broker.ensure(A, 'scoped-token-value')
        expect(again).toEqual(first)
        await expect(broker.ensure(B, 'scoped-token-value')).rejects.toThrow('viewer-capacity-exhausted')
        expect(docker.stop).not.toHaveBeenCalled()
    })

    it('stops only idle runtimes and preserves profile volumes', async () => {
        let now = 1_000
        const docker = runtime()
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, idleTtlMs: 100, now: () => now })
        await broker.ensure(A, 'scoped-token-value')
        await broker.ensure(B, 'scoped-token-value')
        now = 1_050
        await broker.touch(B)
        now = 1_101

        await expect(broker.sweepIdle()).resolves.toEqual([A])
        expect(docker.stop).toHaveBeenCalledWith(A)
        expect(docker.stop).not.toHaveBeenCalledWith(B)
    })

    it('touches the lease that owns an active relay web port', async () => {
        let now = 1_000
        const docker = runtime()
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, now: () => now })
        await broker.ensure(A, 'scoped-token-value')

        now = 1_500
        await expect(broker.touchWebPort(49100)).resolves.toMatchObject({
            viewerKey: A,
            webPort: 49100,
            lastUsedAt: 1_500,
        })
        await expect(broker.touchWebPort(65530)).resolves.toBeNull()
    })

    it('allows one explicit legacy migration and records an audit event', async () => {
        const stateDir = await mkdtemp(join(tmpdir(), 'happy-browser-broker-'))
        const docker = runtime()
        const broker = new BrowserSessionBroker({
            runtime: docker,
            maxActive: 2,
            stateDir,
            legacyProfileDir: '/root/.happy/chrome-profiles/default',
        })

        await expect(broker.migrateLegacy(A)).resolves.toBe(true)
        await expect(broker.migrateLegacy(A)).rejects.toThrow('already-migrated')
        expect(docker.migrateLegacyProfile).toHaveBeenCalledTimes(1)
        expect(await readFile(join(stateDir, 'audit.jsonl'), 'utf8')).toContain('migrate-legacy')
    })

    it('shares one legacy profile copy across concurrent migration requests', async () => {
        const stateDir = await mkdtemp(join(tmpdir(), 'happy-browser-broker-'))
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        let firstCopyStarted!: () => void
        const copyStarted = new Promise<void>((resolve) => { firstCopyStarted = resolve })
        const docker = runtime()
        docker.migrateLegacyProfile.mockImplementation(async () => {
            firstCopyStarted()
            await gate
        })
        const broker = new BrowserSessionBroker({
            runtime: docker,
            maxActive: 2,
            stateDir,
            legacyProfileDir: '/root/.happy/chrome-profiles/default',
        })

        const first = broker.migrateLegacy(A)
        await copyStarted
        const concurrent = broker.migrateLegacy(A)
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(docker.migrateLegacyProfile).toHaveBeenCalledTimes(1)
        release()
        await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true])
    })

    it('stops a runtime that exceeds its persistent profile quota without deleting the volume', async () => {
        const docker = runtime()
        docker.profileBytes.mockImplementation(async (viewerKey: string) => viewerKey === A ? 101 : 10)
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, maxProfileBytes: 100 })
        await broker.ensure(A, 'scoped-token-value')
        await broker.ensure(B, 'scoped-token-value')

        await expect(broker.sweepIdle()).resolves.toEqual([A])
        expect(docker.stop).toHaveBeenCalledWith(A)
    })

    it('continues sweeping other viewers when one runtime stop fails', async () => {
        let now = 1_000
        const docker = runtime()
        docker.stop.mockImplementation(async (viewerKey: string) => {
            if (viewerKey === A) throw new Error('docker unavailable for A')
            return true
        })
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, idleTtlMs: 100, now: () => now })
        await broker.ensure(A, 'scoped-token-value')
        await broker.ensure(B, 'scoped-token-value')
        now = 1_101

        await expect(broker.sweepIdle()).rejects.toThrow('docker unavailable for A')
        expect(docker.stop).toHaveBeenCalledWith(A)
        expect(docker.stop).toHaveBeenCalledWith(B)
    })

    it('shares one in-flight start and reserves capacity before the runtime is ready', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const docker = runtime()
        docker.ensure.mockImplementation(async (viewerKey: string) => {
            await gate
            return {
                webPort: viewerKey === A ? 49100 : 49101,
                profileVolume: `volume-${viewerKey}`,
                reused: false,
            }
        })
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 1 })

        const first = broker.ensure(A, 'scoped-token-value')
        const same = broker.ensure(A, 'scoped-token-value')
        await expect(broker.ensure(B, 'scoped-token-value')).rejects.toThrow('viewer-capacity-exhausted')
        expect(docker.ensure).toHaveBeenCalledTimes(1)
        release()
        await expect(Promise.all([first, same])).resolves.toHaveLength(2)
    })

    it('restarts a cached lease whose container disappeared', async () => {
        const docker = runtime()
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 1 })
        await broker.ensure(A, 'scoped-token-value')
        docker.lookup.mockResolvedValueOnce(null)

        await expect(broker.ensure(A, 'scoped-token-value')).resolves.toMatchObject({ viewerKey: A })
        expect(docker.ensure).toHaveBeenCalledTimes(2)
    })
})

/**
 * specs/runtime-isolation-hardening (H3, P3) — the fingerprint is the broker's
 * statement that it *just* verified the container behind this viewer port.
 *
 * Everything here is about not letting that statement outlive the check. A
 * cached lease carries the fingerprint of the moment it was made; re-serving
 * it after a lookup that could no longer prove anything would turn "verified
 * now" into "was verified once", which is exactly the claim a restarted or
 * replaced container needs to be refused on.
 */
describe('BrowserSessionBroker — verified runtime fingerprint passthrough', () => {
    function runtimeWithFingerprint(fingerprint: string | undefined) {
        const base = runtime()
        return {
            ...base,
            ensure: vi.fn(async (viewerKey: string) => ({
                webPort: 49100,
                profileVolume: `volume-${viewerKey}`,
                reused: false,
                ...(fingerprint ? { runtimeFingerprint: fingerprint } : {}),
            })),
            lookup: vi.fn(async (viewerKey: string) => ({
                webPort: 49100,
                profileVolume: `volume-${viewerKey}`,
                ...(fingerprint ? { runtimeFingerprint: fingerprint } : {}),
            })),
        }
    }

    it('carries the fingerprint from ensure and lookup to the lease', async () => {
        const docker = runtimeWithFingerprint('fp-1')
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, now: () => 1_000 })

        await expect(broker.ensure(A, 'scoped-token-value')).resolves.toMatchObject({ runtimeFingerprint: 'fp-1' })
        await expect(broker.lookup(A)).resolves.toMatchObject({ runtimeFingerprint: 'fp-1' })
    })

    it('drops a cached fingerprint when the runtime can no longer prove one', async () => {
        // Without this the stale value survives the spread and a bound token
        // keeps verifying against evidence nobody could re-read.
        const docker = runtimeWithFingerprint('fp-1')
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, now: () => 1_000 })
        await broker.ensure(A, 'scoped-token-value')

        docker.lookup.mockResolvedValue({ webPort: 49100, profileVolume: `volume-${A}` } as never)

        const lease = await broker.lookup(A)
        expect(lease).toMatchObject({ webPort: 49100 })
        expect(lease?.runtimeFingerprint).toBeUndefined()
    })

    it('replaces the fingerprint when the container behind the port changed', async () => {
        const docker = runtimeWithFingerprint('fp-1')
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, now: () => 1_000 })
        await broker.ensure(A, 'scoped-token-value')

        docker.lookup.mockResolvedValue({
            webPort: 49100,
            profileVolume: `volume-${A}`,
            runtimeFingerprint: 'fp-2',
        } as never)

        await expect(broker.lookup(A)).resolves.toMatchObject({ runtimeFingerprint: 'fp-2' })
    })

    it('does not report a fingerprint from touch, which verifies nothing', async () => {
        // touch only records activity. Letting it hand back the last known
        // fingerprint would make an idle-keepalive look like a fresh proof.
        const docker = runtimeWithFingerprint('fp-1')
        const broker = new BrowserSessionBroker({ runtime: docker, maxActive: 2, now: () => 1_000 })
        await broker.ensure(A, 'scoped-token-value')

        expect((await broker.touch(A))?.runtimeFingerprint).toBeUndefined()
        expect((await broker.touchWebPort(49100))?.runtimeFingerprint).toBeUndefined()
        expect(docker.lookup).not.toHaveBeenCalled()
    })
})
