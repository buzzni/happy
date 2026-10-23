import { describe, expect, it, vi } from 'vitest'
import type { DaemonLocallyPersistedState } from '@/persistence'
import {
    DaemonStopRefusedError,
    DRAINED_DAEMON_EXIT_WAIT_MS,
    LEGACY_DAEMON_EXIT_WAIT_MS,
    parseDaemonStopArgs,
    stopDaemonWithDrain,
    type DaemonPostResult,
    type RestartDrainClientDeps,
} from './restartDrainClient'

const baseState: DaemonLocallyPersistedState = {
    pid: 4242, httpPort: 1, startTime: 'x', startedWithCliVersion: '1.1.10', state: 'running',
    identity: { pid: 4242, startedAt: 1_000, bootId: 'boot' },
}

function view(overrides: Record<string, unknown> = {}) {
    return { version: 1, operationId: 'op-1', state: 'draining', intent: 'stop', reason: 'env-reapply', trigger: 'request',
        inTurnCount: 1, openTerminalCount: 0, busyTerminalCount: 0, deadlineAt: 15_000, ...overrides }
}

function harness(options: {
    state?: DaemonLocallyPersistedState | null
    routes?: Record<string, (body: any) => DaemonPostResult>
    exitsAfterStop?: boolean
    verdict?: 'match' | 'mismatch' | 'dead' | 'unknown'
} = {}) {
    let now = 0
    let alive = true
    const calls: Array<{ path: string; body: any }> = []
    const routes: Record<string, (body: any) => DaemonPostResult> = {
        '/restart-drain/capabilities': () => ({ ok: true, body: { supported: true, capability: 'daemon-restart-drain-v1', instanceId: '4242:1000' } }),
        '/restart-drain/begin': () => ({ ok: true, body: view({ state: 'ready' }) }),
        '/stop': () => {
            if (options.exitsAfterStop !== false) alive = false
            return { ok: true, body: { status: 'stopping' } }
        },
        ...options.routes,
    }
    const deps: RestartDrainClientDeps = {
        readState: async () => (options.state === undefined ? baseState : options.state),
        post: vi.fn(async (path: string, body: unknown) => {
            calls.push({ path, body })
            const route = routes[path]
            return route ? route(body) : { ok: false as const, status: 404, error: `HTTP 404 ${path}` }
        }),
        isPidAlive: () => alive,
        verifyIdentity: vi.fn(async () => options.verdict ?? 'match'),
        kill: vi.fn(() => { alive = false }),
        markStale: vi.fn(),
        sleep: async (ms) => { now += ms },
        now: () => now,
        randomId: () => 'req-1',
        log: () => {},
    }
    return { deps, calls, paths: () => calls.map((call) => call.path), get now() { return now } }
}

describe('stopDaemonWithDrain (plan §2.2)', () => {
    it('does nothing without a running daemon', async () => {
        const h = harness({ state: null })
        await expect(stopDaemonWithDrain({}, h.deps)).resolves.toBe('not-running')
        expect(h.calls).toEqual([])
    })

    it('new daemon: begins a drain with the reason and lease, then stops once ready', async () => {
        const h = harness()
        await expect(stopDaemonWithDrain({ reason: 'env-reapply' }, h.deps)).resolves.toBe('stopped')
        expect(h.paths()).toEqual(['/restart-drain/capabilities', '/restart-drain/begin', '/stop'])
        expect(h.calls[1].body).toEqual({ requestId: 'req-1', expectedInstanceId: '4242:1000', reason: 'env-reapply', intent: 'stop', leaseSeconds: 30 })
        expect(h.deps.kill).not.toHaveBeenCalled()
    })

    it('a plain stop is a grace-0 drain', async () => {
        const h = harness()
        await stopDaemonWithDrain({ graceSeconds: 0 }, h.deps)
        expect(h.calls[1].body).toMatchObject({ graceSeconds: 0, intent: 'stop' })
    })

    it('polls status (renewing the lease) and reports progress until ready', async () => {
        let polls = 0
        const progress = vi.fn()
        const h = harness({ routes: {
            '/restart-drain/begin': () => ({ ok: true, body: view() }),
            '/restart-drain/status': () => ({ ok: true, body: view({ state: ++polls >= 3 ? 'ready' : 'draining', inTurnCount: 3 - polls }) }),
        } })
        await stopDaemonWithDrain({ reason: 'account-switch', onProgress: progress }, h.deps)
        expect(h.paths().filter((path) => path === '/restart-drain/status')).toHaveLength(3)
        expect(h.calls.find((call) => call.path === '/restart-drain/status')?.body).toEqual({ expectedInstanceId: '4242:1000', operationId: 'op-1' })
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({ kind: 'draining', inTurnCount: 1, secondsLeft: 15 }))
        expect(h.paths().at(-1)).toBe('/stop')
    })

    it('waits the drained daemon its 10 s cleanup before an identity-checked kill', async () => {
        const h = harness({ exitsAfterStop: false })
        await stopDaemonWithDrain({}, h.deps)
        expect(h.now).toBeGreaterThanOrEqual(DRAINED_DAEMON_EXIT_WAIT_MS)
        expect(h.deps.verifyIdentity).toHaveBeenCalledWith(baseState.identity)
        expect(h.deps.kill).toHaveBeenCalledWith(4242)
    })

    it('--no-wait hands the drain to the daemon (lease 0) and returns at once', async () => {
        const h = harness()
        await expect(stopDaemonWithDrain({ noWait: true }, h.deps)).resolves.toBe('handed-to-daemon')
        expect(h.calls[1].body).toMatchObject({ leaseSeconds: 0 })
        expect(h.paths()).not.toContain('/stop')
    })

    it('begins once more when the daemon called the drain off (lease lapsed while suspended)', async () => {
        let begins = 0
        const h = harness({ routes: {
            '/restart-drain/begin': () => ({ ok: true, body: view({ state: ++begins === 1 ? 'draining' : 'ready', operationId: `op-${begins}` }) }),
            '/restart-drain/status': () => ({ ok: true, body: view({ state: 'cancelled', operationId: 'op-1' }) }),
        } })
        await expect(stopDaemonWithDrain({ reason: 'env-reapply' }, h.deps)).resolves.toBe('stopped')
        expect(h.paths()).toEqual(['/restart-drain/capabilities', '/restart-drain/begin', '/restart-drain/status', '/restart-drain/begin', '/stop'])
    })

    it('never stops a daemon whose drain was called off twice', async () => {
        const h = harness({ routes: { '/restart-drain/begin': () => ({ ok: true, body: view({ state: 'cancelled' }) }) } })
        await expect(stopDaemonWithDrain({}, h.deps)).resolves.toBe('left-running')
        expect(h.paths()).not.toContain('/stop')
        expect(h.deps.kill).not.toHaveBeenCalled()
    })

    it('waits for a daemon that is already handing itself over, without /stop or a kill', async () => {
        const h = harness({ routes: { '/restart-drain/begin': () => ({ ok: false, status: 409, code: 'RESTART_DRAIN_HANDING_OFF', error: 'handing-off' }) } })
        await expect(stopDaemonWithDrain({}, h.deps)).resolves.toBe('stopped')
        expect(h.paths()).not.toContain('/stop')
        expect(h.deps.kill).not.toHaveBeenCalled()
    })

    describe('old daemon (R22: capability missing / begin 404)', () => {
        it('stops with /stop and waits 15 s (not 2 s) before an identity-checked kill', async () => {
            const h = harness({ exitsAfterStop: false, routes: { '/restart-drain/capabilities': () => ({ ok: false, status: 404, error: '404' }) } })
            await stopDaemonWithDrain({}, h.deps)
            expect(h.paths()).toEqual(['/restart-drain/capabilities', '/stop'])
            expect(h.now).toBeGreaterThanOrEqual(LEGACY_DAEMON_EXIT_WAIT_MS)
            expect(h.deps.kill).toHaveBeenCalledTimes(1)
        })

        it('never kills before the 15 s are up when the daemon exits in time', async () => {
            const h = harness({ routes: { '/restart-drain/capabilities': () => ({ ok: false, status: 404, error: '404' }) } })
            await stopDaemonWithDrain({}, h.deps)
            expect(h.deps.kill).not.toHaveBeenCalled()
        })

        it('keeps a refusal a refusal (401/409 → no force kill)', async () => {
            const h = harness({ routes: {
                '/restart-drain/capabilities': () => ({ ok: false, status: 404, error: '404' }),
                '/stop': () => ({ ok: false, status: 409, error: 'drain-required' }),
            } })
            await expect(stopDaemonWithDrain({}, h.deps)).rejects.toBeInstanceOf(DaemonStopRefusedError)
            expect(h.deps.kill).not.toHaveBeenCalled()
        })

        it('treats a 401 on begin as a refusal', async () => {
            const h = harness({ routes: { '/restart-drain/begin': () => ({ ok: false, status: 401, error: 'unauthorized' }) } })
            await expect(stopDaemonWithDrain({}, h.deps)).rejects.toBeInstanceOf(DaemonStopRefusedError)
        })
    })

    describe('identity before any signal (R19)', () => {
        it('never signals a reused pid and marks the state stale instead', async () => {
            const h = harness({ verdict: 'mismatch', routes: { '/restart-drain/capabilities': () => ({ ok: false, error: 'ECONNREFUSED' }) } })
            await expect(stopDaemonWithDrain({}, h.deps)).resolves.toBe('not-running')
            expect(h.deps.kill).not.toHaveBeenCalled()
            expect(h.deps.markStale).toHaveBeenCalledWith(baseState, expect.stringContaining('reused'))
        })

        it('does not kill a pid that turned into another process during the legacy wait', async () => {
            const h = harness({ exitsAfterStop: false, verdict: 'mismatch', routes: { '/restart-drain/capabilities': () => ({ ok: false, status: 404, error: '404' }) } })
            await stopDaemonWithDrain({}, h.deps)
            expect(h.deps.kill).not.toHaveBeenCalled()
        })

        it('keeps the pid-only behaviour for a state file without identity', async () => {
            const h = harness({ exitsAfterStop: false, state: { ...baseState, identity: undefined }, routes: { '/restart-drain/capabilities': () => ({ ok: false, status: 404, error: '404' }) } })
            await stopDaemonWithDrain({}, h.deps)
            expect(h.deps.verifyIdentity).not.toHaveBeenCalled()
            expect(h.deps.kill).toHaveBeenCalledTimes(1)
        })
    })
})

describe('parseDaemonStopArgs (R5)', () => {
    it('plain stop is a grace-0 drain', () => {
        expect(parseDaemonStopArgs('stop', [])).toEqual({ ok: true, options: { intent: 'stop', reason: 'user-restart', graceSeconds: 0 } })
    })

    it('--for-restart leaves the grace to the reason (account-switch → daemon default 15 s)', () => {
        expect(parseDaemonStopArgs('stop', ['--for-restart', '--reason', 'account-switch'])).toEqual({ ok: true, options: { intent: 'stop', reason: 'account-switch' } })
        expect(parseDaemonStopArgs('stop', ['--for-restart'])).toEqual({ ok: true, options: { intent: 'stop', reason: 'user-restart' } })
    })

    it('--grace overrides and --no-wait hands off to the daemon', () => {
        expect(parseDaemonStopArgs('stop', ['--for-restart', '--reason', 'env-reapply', '--grace', '40', '--no-wait'])).toEqual({
            ok: true, options: { intent: 'stop', reason: 'env-reapply', graceSeconds: 40, noWait: true },
        })
    })

    it('refuses daemon-internal reasons, bad graces and flags without --for-restart', () => {
        expect(parseDaemonStopArgs('stop', ['--for-restart', '--reason', 'signal']).ok).toBe(false)
        expect(parseDaemonStopArgs('stop', ['--for-restart', '--grace', '301']).ok).toBe(false)
        expect(parseDaemonStopArgs('stop', ['--grace', '5']).ok).toBe(false)
        expect(parseDaemonStopArgs('stop', ['--bogus']).ok).toBe(false)
    })

    it('restart is a user-restart drain, optionally forced', () => {
        expect(parseDaemonStopArgs('restart', ['--force'])).toEqual({ ok: true, options: { intent: 'restart', reason: 'user-restart', force: true } })
        expect(parseDaemonStopArgs('restart', ['--grace', '0'])).toEqual({ ok: true, options: { intent: 'restart', reason: 'user-restart', graceSeconds: 0 } })
    })
})
