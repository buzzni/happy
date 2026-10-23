import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestartDrainActivity } from './restartDrain'
import { createDaemonRestartDrainRuntime, type DaemonRestartDrainRuntime } from './restartDrainRuntime'

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

function harness(options: { activity?: Partial<RestartDrainActivity>; preflight?: boolean; preflightImpl?: () => Promise<boolean>; env?: NodeJS.ProcessEnv } = {}) {
    let now = 1_000_000
    let activity: RestartDrainActivity = { inTurnCount: 0, automationCount: 0, busyTerminalCount: 0, openTerminalCount: 0, ...options.activity }
    const home = mkdtempSync(join(tmpdir(), 'drain-runtime-'))
    const calls: string[] = []
    const admission = { closed: false }
    const spies = {
        closeTerminalsForRestart: vi.fn(async () => { calls.push('close-terminals'); return 1 }),
        preflightReplacement: vi.fn(async () => { calls.push('preflight'); return options.preflightImpl ? options.preflightImpl() : options.preflight ?? true }),
        handOff: vi.fn(async () => { calls.push('hand-off') }),
        shutdown: vi.fn(() => { calls.push('shutdown') }),
        publishLifecycle: vi.fn(),
        log: vi.fn(),
    }
    const runtime: DaemonRestartDrainRuntime = createDaemonRestartDrainRuntime({
        instanceId: '1:2',
        now: () => now,
        activity: () => activity,
        closeAdmission: () => { admission.closed = true; calls.push('close-admission') },
        reopenAdmission: () => { admission.closed = false; calls.push('reopen-admission') },
        happyHomeDir: home,
        cliVersion: '1.1.10-test',
        env: options.env ?? {},
        tickIntervalMs: 5,
        ...spies,
    })
    return {
        runtime, spies, calls, admission, home,
        advance: (ms: number) => { now += ms },
        setActivity: (next: Partial<RestartDrainActivity>) => { activity = { ...activity, ...next } },
        ledger: () => {
            try { return readFileSync(join(home, 'restart-drain-outcomes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) } catch { return [] }
        },
    }
}

describe('daemon restart drain runtime', () => {
    let current: ReturnType<typeof harness> | undefined
    afterEach(() => { current?.runtime.dispose(); current = undefined })

    describe('bundle handoff (R4)', () => {
        // #336: 장수 유휴 세션이 있어도 턴·자동화·사용 중 터미널이 0이면 입장 거절 없이 바로 교대.
        it('hands off at the first quiet heartbeat: preflight → close admission → re-check → hand off', async () => {
            const h = current = harness()
            expect(await h.runtime.heartbeat(true)).toBe('hold-automations')
            await flush()
            expect(h.calls).toEqual(['preflight', 'close-admission', 'close-terminals', 'hand-off'])
            expect(h.ledger()).toEqual([expect.objectContaining({ trigger: 'handoff-prewait', outcome: 'idle', reason: 'bundle-replaced', closedTerminalCount: 1 })])
        })

        it('keeps admission open and automations running while a turn is in flight (pre-wait)', async () => {
            const h = current = harness({ activity: { inTurnCount: 1 } })
            expect(await h.runtime.heartbeat(true)).toBe('run-automations')
            expect(h.admission.closed).toBe(false)
            expect(h.runtime.lifecycle()).toMatchObject({ state: 'running', pendingHandoff: { forceAvailable: false } })
            expect(h.spies.preflightReplacement).not.toHaveBeenCalled()
        })

        it('does not open a drain when preflight fails (kept-current)', async () => {
            const h = current = harness({ preflight: false })
            expect(await h.runtime.heartbeat(true)).toBe('run-automations')
            expect(h.admission.closed).toBe(false)
            expect(h.spies.handOff).not.toHaveBeenCalled()
        })

        it('drains with grace 120 s at the 30 min cap and hands off without killing the turn', async () => {
            const h = current = harness({ activity: { inTurnCount: 1 } })
            await h.runtime.heartbeat(true)
            h.advance(30 * 60_000)
            expect(await h.runtime.heartbeat(true)).toBe('hold-automations')
            expect(h.runtime.lifecycle()).toMatchObject({ state: 'draining', reason: 'bundle-replaced', inTurnCount: 1, deadlineAt: expect.any(Number) })
            h.advance(120_000)
            await flush()
            expect(h.spies.handOff).toHaveBeenCalledTimes(1)
            expect(h.ledger()).toEqual([expect.objectContaining({ trigger: 'handoff-cap', outcome: 'deadline', inTurnCountAtDeadline: 1, sessionsAfter: 'kept' })])
        })

        it('does not enter the cap drain while a terminal is in use, and offers "지금 교대" at 24 h (R25)', async () => {
            const h = current = harness({ activity: { busyTerminalCount: 1 } })
            await h.runtime.heartbeat(true)
            h.advance(31 * 60_000)
            expect(await h.runtime.heartbeat(true)).toBe('run-automations')
            h.advance(24 * 60 * 60_000)
            await h.runtime.heartbeat(true)
            expect(h.runtime.lifecycle()).toMatchObject({ state: 'running', pendingHandoff: { busyTerminalCount: 1, forceAvailable: true } })
            expect(await h.runtime.heartbeat(true)).toBe('hold-automations')
            expect(h.runtime.lifecycle()).toMatchObject({ state: 'draining', busyTerminalCount: 1, pendingHandoff: { forceAvailable: true } })
        })

        it('clears the pending handoff when the bundle is no longer replaced', async () => {
            const h = current = harness({ activity: { inTurnCount: 1 } })
            await h.runtime.heartbeat(true)
            await h.runtime.heartbeat(false)
            expect(h.runtime.pendingHandoff()).toBeNull()
        })
    })

    describe('지금 교대 — restart-drain:force-handoff (R25)', () => {
        it('refuses when no handoff is pending — it can never start a restart', async () => {
            const h = current = harness()
            await expect(h.runtime.forceHandoff()).resolves.toEqual({ ok: false, code: 'no-pending-handoff' })
            expect(h.admission.closed).toBe(false)
        })

        it('pulls an open terminal-cap drain to now', async () => {
            const h = current = harness({ activity: { busyTerminalCount: 1 } })
            await h.runtime.heartbeat(true)
            h.advance(24 * 60 * 60_000)
            await h.runtime.heartbeat(true)
            await h.runtime.heartbeat(true)
            const forced = await h.runtime.forceHandoff()
            expect(forced).toEqual({ ok: true, deadlineAt: expect.any(Number) })
            await flush()
            expect(h.spies.handOff).toHaveBeenCalledTimes(1)
            expect(h.ledger().at(-1)).toMatchObject({ outcome: 'force', trigger: 'handoff-terminal-cap' })
        })

        // Cross review H6: "지금 교대" hastens the pending handoff only, never someone's requested drain.
        it('leaves an open requested drain (e.g. account-switch) at its own deadline', async () => {
            const h = current = harness({ activity: { busyTerminalCount: 1 } })
            await h.runtime.heartbeat(true)
            h.setActivity({ inTurnCount: 1 })
            const stop = h.runtime.controlPort.begin({ reason: 'account-switch', intent: 'stop', trigger: 'request' })
            const deadlineAt = stop.ok ? stop.view.deadlineAt : 0
            await expect(h.runtime.forceHandoff()).resolves.toEqual({ ok: true, deadlineAt })
            expect(h.runtime.controller.current()).toMatchObject({ state: 'draining', deadlineAt })
        })

        it('starts a forced drain when the handoff is pending but no drain is open yet', async () => {
            const h = current = harness({ activity: { busyTerminalCount: 1 } })
            await h.runtime.heartbeat(true)
            await expect(h.runtime.forceHandoff()).resolves.toMatchObject({ ok: true })
            await flush()
            expect(h.spies.handOff).toHaveBeenCalledTimes(1)
        })
    })

    describe('requested drains (R24)', () => {
        it('an abandoned stop reopens admission and records cancelled', async () => {
            const h = current = harness({ activity: { inTurnCount: 1 } })
            h.runtime.controlPort.begin({ reason: 'account-switch', intent: 'stop', trigger: 'request', leaseSeconds: 1 })
            expect(h.admission.closed).toBe(true)
            h.advance(1_001)
            await flush()
            expect(h.admission.closed).toBe(false)
            expect(h.ledger()).toEqual([expect.objectContaining({ outcome: 'cancelled', reason: 'account-switch', intent: 'stop' })])
            expect(h.spies.log).toHaveBeenCalledWith(expect.stringContaining('drain-abandoned'))
        })

        it('an abandoned restart preflights and hands off by itself', async () => {
            const h = current = harness({ activity: { inTurnCount: 1 } })
            h.runtime.controlPort.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request', leaseSeconds: 1 })
            h.advance(1_001)
            h.setActivity({ inTurnCount: 0 })
            await flush()
            expect(h.calls).toEqual(['close-admission', 'preflight', 'close-terminals', 'hand-off'])
        })

        it('a ready drain called off afterwards closes no terminal and records one cancelled line', async () => {
            const h = current = harness({ preflight: false })
            const begun = h.runtime.controlPort.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request', leaseSeconds: 1 })
            expect(begun.ok && begun.view.state).toBe('ready')
            h.advance(1_001)
            await flush()
            expect(h.spies.closeTerminalsForRestart).not.toHaveBeenCalled()
            expect(h.admission.closed).toBe(false)
            expect(h.ledger()).toEqual([expect.objectContaining({ outcome: 'cancelled' })])
        })

        it('a stop with no-wait (lease 0) shuts down after draining, without a replacement', async () => {
            const h = current = harness()
            h.runtime.controlPort.begin({ reason: 'user-restart', intent: 'stop', trigger: 'request', leaseSeconds: 0 })
            await flush()
            expect(h.spies.shutdown).toHaveBeenCalledTimes(1)
            expect(h.spies.handOff).not.toHaveBeenCalled()
        })

        // Cross review H1: a handoff whose preflight was still running must not join a drain that opened meanwhile —
        // joining would turn a requested stop (e.g. account-switch) into this daemon restarting itself.
        it('drops a handoff whose preflight finished after a requested stop drain opened', async () => {
            let finishPreflight!: (ok: boolean) => void
            const h = current = harness({ preflightImpl: () => new Promise((resolve) => { finishPreflight = resolve }) })
            const beat = h.runtime.heartbeat(true)
            await flush()
            h.setActivity({ inTurnCount: 1 })
            const stop = h.runtime.controlPort.begin({ reason: 'account-switch', intent: 'stop', trigger: 'request' })
            finishPreflight(true)
            expect(await beat).toBe('hold-automations')
            expect(h.runtime.controller.current()).toMatchObject({ intent: 'stop', reason: 'account-switch', state: 'draining' })
            h.setActivity({ inTurnCount: 0 })
            h.runtime.controlPort.status(stop.ok ? stop.view.operationId : '')
            await flush()
            expect(h.runtime.controller.current()).toMatchObject({ intent: 'stop', state: 'ready' })
            expect(h.spies.handOff).not.toHaveBeenCalled()
        })

        // Cross review H2: once the daemon hands itself over, /stop is refused like a begin (handing-off),
        // so a normal shutdown never races the replacement spawn.
        it('refuses /stop as handing-off once the daemon hands itself over', async () => {
            let finishPreflight!: (ok: boolean) => void
            const h = current = harness({ activity: { inTurnCount: 1 }, preflightImpl: () => new Promise((resolve) => { finishPreflight = resolve }) })
            h.runtime.controlPort.begin({ reason: 'user-restart', intent: 'restart', trigger: 'request', leaseSeconds: 0 })
            expect(h.runtime.controlPort.handingOff()).toBe(false)
            h.setActivity({ inTurnCount: 0 })
            h.runtime.controller.tick()
            expect(h.runtime.controlPort.stopBlocked()).toBe(false)
            expect(h.runtime.controlPort.handingOff()).toBe(true)
            await flush()
            finishPreflight(true)
            await flush()
            expect(h.spies.handOff).toHaveBeenCalledTimes(1)
            expect(h.runtime.controlPort.handingOff()).toBe(true)
        })

        it('blocks /stop only while draining (not once ready)', async () => {
            const h = current = harness({ activity: { inTurnCount: 1 } })
            const begun = h.runtime.controlPort.begin({ reason: 'env-reapply', intent: 'stop', trigger: 'request' })
            expect(h.runtime.controlPort.stopBlocked()).toBe(true)
            h.setActivity({ inTurnCount: 0 })
            h.runtime.controlPort.status(begun.ok ? begun.view.operationId : '')
            expect(h.runtime.controlPort.stopBlocked()).toBe(false)
            // Not final until the daemon really stops: nothing closed, nothing recorded yet.
            expect(h.spies.closeTerminalsForRestart).not.toHaveBeenCalled()
            expect(h.ledger()).toEqual([])
            await h.runtime.finalizeReady()
            expect(h.ledger()).toEqual([expect.objectContaining({ outcome: 'idle', reason: 'env-reapply', closedTerminalCount: 1 })])
        })
    })

    it('SIGHUP is a self-completing restart (R20)', async () => {
        const h = current = harness()
        await h.runtime.sighup()
        await flush()
        expect(h.calls).toEqual(['preflight', 'close-admission', 'close-terminals', 'hand-off'])
        expect(h.ledger()).toEqual([expect.objectContaining({ trigger: 'signal', reason: 'signal' })])
    })
})
