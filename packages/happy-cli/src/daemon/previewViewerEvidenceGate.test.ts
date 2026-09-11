/**
 * specs/runtime-isolation-hardening (H3, P3) — the bound around viewer proof
 * work.
 *
 * The defect this closes: `viewerLeaseDeps` accepted a `probeDeadlineMs` and
 * ignored it, and the viewer path reached the /proc prober directly instead of
 * going through the project probe's concurrency gate. Two consequences, both
 * real:
 *
 * - a *current* daemon that was merely slow answered the mint event after
 *   happy-server's 3 s window and was recorded as "predates runtime binding".
 *   Being misread as an old daemon is worse than refusing: it is a wrong fact
 *   about the fleet, written down.
 * - HTTP and WS evidence ran unbounded, so a burst of relayed sub-resources
 *   could spawn proof work without limit.
 *
 * What is bounded here is the **whole proof** — registry or broker lookup,
 * native probe and cmdline read — not just the probe inside it, because the
 * lookup is exactly the part that can hang.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROBE_LIMITS } from './previewRuntimeEvidence'
import type { ViewerEvidenceRequest, ViewerEvidenceResult } from './previewViewerEvidence'
import {
    DEFAULT_VIEWER_PROOF_DEADLINE_MS,
    createBoundedViewerProof,
} from './previewViewerEvidenceGate'

const KEY_A = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const KEY_B = 'bv1_abcdefghijklmnopqrstuvwxyz012346'

const FOUND: ViewerEvidenceResult = {
    status: 'found',
    evidence: { kind: 'viewer-native', fingerprint: 'f'.repeat(64) },
}

const LIMITS = { maxConcurrent: 2, maxQueued: 2, maxWaitMs: 20_000 }

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

const request = (viewerKey = KEY_A, port = 6080): ViewerEvidenceRequest => ({ viewerKey, port })

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('createBoundedViewerProof — deadline', () => {
    it('refuses with EVIDENCE_BUSY when the whole proof outruns the default budget', async () => {
        const gate = deferred<ViewerEvidenceResult>()
        const proof = vi.fn(() => gate.promise)
        const bounded = createBoundedViewerProof(proof, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        await vi.advanceTimersByTimeAsync(DEFAULT_VIEWER_PROOF_DEADLINE_MS - 1)
        await vi.advanceTimersByTimeAsync(1)

        await expect(answer).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
    })

    it('defaults every viewer proof to 2500ms, under the mint window it has to fit in', async () => {
        // happy-server waits 3 s for the mint ack, 15 s for a WS open, 35 s for
        // an HTTP relay and 5 s for a WS recheck. One budget under the
        // smallest of those answers all four in time.
        expect(DEFAULT_VIEWER_PROOF_DEADLINE_MS).toBe(2_500)
    })

    it('honours a caller budget shorter than the default', async () => {
        const proof = vi.fn(() => deferred<ViewerEvidenceResult>().promise)
        const bounded = createBoundedViewerProof(proof, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request(), { deadlineMs: 500 })
        await vi.advanceTimersByTimeAsync(500)

        await expect(answer).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
    })

    it('answers normally when the proof lands inside the budget', async () => {
        const gate = deferred<ViewerEvidenceResult>()
        const bounded = createBoundedViewerProof(() => gate.promise, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        gate.resolve(FOUND)

        await expect(answer).resolves.toEqual(FOUND)
    })

    it('never answers twice: a proof that lands after the deadline is discarded', async () => {
        const gate = deferred<ViewerEvidenceResult>()
        const bounded = createBoundedViewerProof(() => gate.promise, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        await vi.advanceTimersByTimeAsync(DEFAULT_VIEWER_PROOF_DEADLINE_MS)
        gate.resolve(FOUND)

        // The late `found` must not become the answer — the caller already
        // acted on BUSY, and relaying on a proof nobody waited for is the
        // window this whole design closes.
        await expect(answer).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
    })

    it('drops a late failure rather than turning it into a second answer', async () => {
        const gate = deferred<ViewerEvidenceResult>()
        const bounded = createBoundedViewerProof(() => gate.promise, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        await vi.advanceTimersByTimeAsync(DEFAULT_VIEWER_PROOF_DEADLINE_MS)
        gate.reject(new Error('broker socket gone'))

        await expect(answer).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
    })

    it('propagates a failure that lands inside the budget', async () => {
        const gate = deferred<ViewerEvidenceResult>()
        const bounded = createBoundedViewerProof(() => gate.promise, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        gate.reject(new Error('broker socket gone'))

        await expect(answer).rejects.toThrow('broker socket gone')
    })
})

/**
 * The budget is wall-clock, and the deadline timer is only one way of noticing
 * it has run out. When the event loop is delayed, the proof's promise
 * continuation runs in the microtask drain *before* the timers phase — so
 * `answered` is still false while 3 s of real time have passed under a 2.5 s
 * budget. Trusting the flag alone lets that stale proof be adopted and reach
 * upstream, which is the whole thing the budget exists to prevent.
 *
 * `vi.setSystemTime` reproduces exactly that window: it moves `Date.now()`
 * forward while leaving every pending timer its original remaining time, so
 * nothing fires. `advanceTimersByTime` cannot show this — there the clock and
 * the timers always move together.
 */
describe('createBoundedViewerProof — wall clock, not just the timer', () => {
    it('refuses a proof whose budget ran out while its deadline timer had not fired', async () => {
        const gate = deferred<ViewerEvidenceResult>()
        const bounded = createBoundedViewerProof(() => gate.promise, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        vi.setSystemTime(Date.now() + DEFAULT_VIEWER_PROOF_DEADLINE_MS + 100)
        gate.resolve(FOUND)

        await expect(answer).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
    })

    it('refuses a late failure the same way, rather than throwing at the caller', async () => {
        const gate = deferred<ViewerEvidenceResult>()
        const bounded = createBoundedViewerProof(() => gate.promise, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        vi.setSystemTime(Date.now() + DEFAULT_VIEWER_PROOF_DEADLINE_MS + 100)
        gate.reject(new Error('broker socket gone'))

        await expect(answer).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
    })

    it('still adopts a proof that lands one millisecond inside the budget', async () => {
        // The guard must be a deadline, not a blanket refusal.
        const gate = deferred<ViewerEvidenceResult>()
        const bounded = createBoundedViewerProof(() => gate.promise, DEFAULT_PROBE_LIMITS)

        const answer = bounded(request())
        vi.setSystemTime(Date.now() + DEFAULT_VIEWER_PROOF_DEADLINE_MS - 1)
        gate.resolve(FOUND)

        await expect(answer).resolves.toEqual(FOUND)
    })

    it('never starts a queued proof whose budget expired while it waited for a slot', async () => {
        // The slot frees late; the queue's own timer has not fired yet. Taking
        // the waiter off the queue and running it would spawn a subprocess for
        // a caller whose budget is already gone.
        const slow = deferred<ViewerEvidenceResult>()
        const proof = vi.fn(() => slow.promise)
        const bounded = createBoundedViewerProof(proof, { maxConcurrent: 1, maxQueued: 4, maxWaitMs: 20_000 })

        void bounded(request(KEY_A, 6080))
        const queued = bounded(request(KEY_A, 6081))
        await vi.advanceTimersByTimeAsync(0)
        expect(proof).toHaveBeenCalledTimes(1)

        vi.setSystemTime(Date.now() + DEFAULT_VIEWER_PROOF_DEADLINE_MS + 500)
        slow.resolve(FOUND)
        await vi.advanceTimersByTimeAsync(0)

        expect(proof).toHaveBeenCalledTimes(1)
        await expect(queued).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
    })

    it('keeps draining the queue past an expired waiter', async () => {
        // One dead waiter must not stall the ones behind it.
        const slow = deferred<ViewerEvidenceResult>()
        let call = 0
        const live = deferred<ViewerEvidenceResult>()
        const proof = vi.fn(() => (call++ === 0 ? slow.promise : live.promise))
        const bounded = createBoundedViewerProof(proof, { maxConcurrent: 1, maxQueued: 4, maxWaitMs: 20_000 })

        void bounded(request(KEY_A, 6080))
        const expiring = bounded(request(KEY_A, 6081))
        await vi.advanceTimersByTimeAsync(0)

        vi.setSystemTime(Date.now() + DEFAULT_VIEWER_PROOF_DEADLINE_MS + 500)
        // A fresh arrival with its own untouched budget, queued behind the
        // expired one.
        const fresh = bounded(request(KEY_A, 6082))
        slow.resolve(FOUND)
        await vi.advanceTimersByTimeAsync(0)

        await expect(expiring).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
        expect(proof).toHaveBeenCalledTimes(2)
        live.resolve(FOUND)
        await expect(fresh).resolves.toEqual(FOUND)
    })
})

describe('createBoundedViewerProof — concurrency', () => {
    it('runs up to maxConcurrent proofs and queues the rest', async () => {
        const gates = [deferred<ViewerEvidenceResult>(), deferred<ViewerEvidenceResult>(), deferred<ViewerEvidenceResult>()]
        let started = 0
        const proof = vi.fn(() => gates[started++]!.promise)
        const bounded = createBoundedViewerProof(proof, LIMITS)

        void bounded(request(KEY_A, 6080))
        void bounded(request(KEY_B, 6081))
        void bounded(request(KEY_A, 6082))
        await Promise.resolve()

        expect(proof).toHaveBeenCalledTimes(2)

        gates[0]!.resolve(FOUND)
        await vi.advanceTimersByTimeAsync(0)
        expect(proof).toHaveBeenCalledTimes(3)
    })

    it('refuses outright once the queue is full, without starting anything', async () => {
        const proof = vi.fn(() => deferred<ViewerEvidenceResult>().promise)
        const bounded = createBoundedViewerProof(proof, LIMITS)

        void bounded(request(KEY_A, 6080))
        void bounded(request(KEY_A, 6081))
        void bounded(request(KEY_A, 6082))
        void bounded(request(KEY_A, 6083))
        await Promise.resolve()

        await expect(bounded(request(KEY_A, 6084)))
            .resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })
        expect(proof).toHaveBeenCalledTimes(2)
    })

    it('removes a queued request at its deadline so it never starts', async () => {
        const gates = [deferred<ViewerEvidenceResult>(), deferred<ViewerEvidenceResult>()]
        let started = 0
        const proof = vi.fn(() => gates[started++]?.promise ?? deferred<ViewerEvidenceResult>().promise)
        const bounded = createBoundedViewerProof(proof, LIMITS)

        void bounded(request(KEY_A, 6080))
        void bounded(request(KEY_A, 6081))
        const queued = bounded(request(KEY_A, 6082))
        await Promise.resolve()
        expect(proof).toHaveBeenCalledTimes(2)

        await vi.advanceTimersByTimeAsync(DEFAULT_VIEWER_PROOF_DEADLINE_MS)
        await expect(queued).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })

        // Freeing a slot must not resurrect work whose caller has gone.
        gates[0]!.resolve(FOUND)
        await vi.advanceTimersByTimeAsync(0)
        expect(proof).toHaveBeenCalledTimes(2)
    })

    it('keeps a timed-out but still running proof charged against capacity', async () => {
        // The subprocess and the socket read cannot be un-started. Releasing
        // the slot at the deadline would let the bound be exceeded by exactly
        // the work that is proving slow.
        const slow = deferred<ViewerEvidenceResult>()
        const others = [deferred<ViewerEvidenceResult>(), deferred<ViewerEvidenceResult>()]
        let started = 0
        const proof = vi.fn(() => (started++ === 0 ? slow.promise : others[started - 2]!.promise))
        const bounded = createBoundedViewerProof(proof, { maxConcurrent: 1, maxQueued: 4, maxWaitMs: 20_000 })

        const first = bounded(request(KEY_A, 6080))
        await Promise.resolve()
        expect(proof).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(DEFAULT_VIEWER_PROOF_DEADLINE_MS)
        await expect(first).resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_BUSY' })

        // Slot still held: nothing else may start yet.
        void bounded(request(KEY_A, 6081), { deadlineMs: 60_000 })
        await vi.advanceTimersByTimeAsync(0)
        expect(proof).toHaveBeenCalledTimes(1)

        // Only when the real proof settles does the slot come back.
        slow.resolve(FOUND)
        await vi.advanceTimersByTimeAsync(0)
        expect(proof).toHaveBeenCalledTimes(2)
    })
})

describe('createBoundedViewerProof — identity', () => {
    it('passes the request through unchanged', async () => {
        const proof = vi.fn(async () => FOUND)
        const bounded = createBoundedViewerProof(proof, DEFAULT_PROBE_LIMITS)

        await bounded(request(KEY_B, 49123))

        expect(proof).toHaveBeenCalledWith({ viewerKey: KEY_B, port: 49123 })
    })

    it('is a limiter, not a cache: identical concurrent requests each run their own proof', async () => {
        // Reusing an in-flight answer would hand the second request a view of
        // the runtime from before it arrived — the revocation window the
        // per-request design exists to close.
        const proof = vi.fn(async () => FOUND)
        const bounded = createBoundedViewerProof(proof, DEFAULT_PROBE_LIMITS)

        await Promise.all([bounded(request(KEY_A, 6080)), bounded(request(KEY_A, 6080))])

        expect(proof).toHaveBeenCalledTimes(2)
    })

    it('does not reuse a settled answer for a later request', async () => {
        const proof = vi.fn(async () => FOUND)
        const bounded = createBoundedViewerProof(proof, DEFAULT_PROBE_LIMITS)

        await bounded(request())
        await bounded(request())

        expect(proof).toHaveBeenCalledTimes(2)
    })
})
