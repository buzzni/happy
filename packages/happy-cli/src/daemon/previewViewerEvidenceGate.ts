/**
 * specs/runtime-isolation-hardening (H3, P3) — the bound around viewer proof
 * work.
 *
 * `createBoundedProbe` (previewRuntimeEvidence.ts) bounds *one probe call* on
 * the project path. The viewer path needs the same two guarantees over a
 * different unit of work, so the semantics are deliberately identical and the
 * limits are the same object:
 *
 * 1. **A budget for the whole proof.** The bound covers the registry or broker
 *    lookup, the native probe and the cmdline read together — the lookup is a
 *    socket round trip or a file read, and it is exactly the part that can
 *    hang. Bounding only the probe inside it would leave the hang uncovered.
 * 2. **A cap on how much runs at once**, so a burst of relayed sub-resources
 *    cannot spawn unbounded proof work.
 *
 * Past the budget the caller is told `EVIDENCE_BUSY` — never
 * "unsupported", and never a fallback to weaker evidence. That distinction is
 * the whole reason this exists: happy-server reads silence on the mint event
 * as "this daemon predates runtime binding", so a current daemon that was
 * merely slow used to be recorded as an old one. A refusal is recoverable; a
 * wrong fact about the fleet is not.
 *
 * It is a limiter, not a cache and not single-flight: every request that gets
 * a slot runs its own proof against the live system. Reusing an in-flight or
 * settled answer would hand a later request a view of the runtime from before
 * it arrived, which is the revocation window the per-request design closes.
 */

import type { ProbeLimits } from './previewRuntimeEvidence'
import type { ViewerEvidenceRequest, ViewerEvidenceResult } from './previewViewerEvidence'

/**
 * One budget for every viewer proof, chosen to fit under the smallest window
 * any caller has: happy-server waits 3 s for the mint ack, 15 s for a WS open,
 * 35 s for an HTTP relay and 5 s for a WS recheck. 2.5 s answers all four in
 * time, and a proof that cannot finish in it is refused rather than answered
 * late — late is indistinguishable from absent for the caller that matters.
 */
export const DEFAULT_VIEWER_PROOF_DEADLINE_MS = 2_500

export interface ViewerProofCallOptions {
    /** Total budget for *this* call: queue wait plus the running proof. */
    deadlineMs?: number
}

export type ViewerProofFn = (
    request: ViewerEvidenceRequest,
    options?: ViewerProofCallOptions,
) => Promise<ViewerEvidenceResult>

function busy(detail: string): ViewerEvidenceResult {
    return { status: 'error', code: 'EVIDENCE_BUSY', message: detail }
}

export function createBoundedViewerProof(proof: ViewerProofFn, limits: ProbeLimits): ViewerProofFn {
    let running = 0
    interface Waiter {
        request: ViewerEvidenceRequest
        deadlineMs: number
        answer: (result: ViewerEvidenceResult) => void
        fail: (error: unknown) => void
        timer: NodeJS.Timeout | null
        startedAt: number
    }
    const queue: Waiter[] = []

    /**
     * The budget is wall-clock, and the deadline timer is only one *way of
     * noticing* it has run out — not the fact itself. When the loop is
     * delayed, the promise continuation runs in the microtask drain before
     * the timers phase, so a 3 s-old proof can arrive with its 2.5 s timer
     * still pending. Every place that would otherwise trust a flag or a
     * cleared timer asks the clock instead.
     */
    const expired = (waiter: Waiter) => Date.now() - waiter.startedAt >= waiter.deadlineMs

    const overran = (waiter: Waiter) =>
        busy(`viewer runtime proof did not finish within ${waiter.deadlineMs}ms (still running)`)

    const elapsedBeforeStart = (waiter: Waiter) =>
        busy(`viewer runtime proof budget of ${waiter.deadlineMs}ms elapsed before a slot was free`)

    const startNext = () => {
        // A loop, not recursion: a slot freeing late can retire a whole run of
        // expired waiters at once, and one dead waiter must not stall the ones
        // behind it.
        while (queue.length > 0) {
            const next = queue.shift()!
            if (next.timer) clearTimeout(next.timer)
            if (expired(next)) {
                // Its wait timer had not fired yet, but the clock says the
                // caller is gone. Starting the proof here would spawn a
                // subprocess nobody is waiting for.
                next.answer(elapsedBeforeStart(next))
                continue
            }
            run(next)
            return
        }
    }

    const run = (waiter: Waiter) => {
        if (expired(waiter)) {
            // Direct-entry counterpart of the check in startNext.
            waiter.answer(elapsedBeforeStart(waiter))
            startNext()
            return
        }
        running += 1
        let answered = false
        let deadlineTimer: NodeJS.Timeout | null = null
        const remaining = waiter.deadlineMs - (Date.now() - waiter.startedAt)
        // The budget keeps counting while the proof runs. The proof itself is
        // not cancelled — a spawned subprocess and an open socket cannot be
        // un-started — so its slot stays charged until it settles. Releasing
        // the slot at the deadline would let the cap be exceeded by exactly
        // the work that is proving slow.
        deadlineTimer = setTimeout(() => {
            if (answered) return
            answered = true
            waiter.answer(overran(waiter))
        }, Math.max(0, remaining))
        deadlineTimer.unref?.()

        proof(waiter.request).then(
            (result) => {
                if (answered) return // late: discarded, never a second answer
                answered = true
                // The timer may not have run yet even though the budget is
                // gone. Adopting the result on the strength of the flag alone
                // is what would let a stale proof reach upstream.
                waiter.answer(expired(waiter) ? overran(waiter) : result)
            },
            (error) => {
                if (answered) return // late failure: nobody is waiting for it
                answered = true
                // Past the budget the caller gets a refusal, not an exception:
                // one shape for "out of time", whichever way it was noticed.
                if (expired(waiter)) waiter.answer(overran(waiter))
                else waiter.fail(error)
            },
        ).finally(() => {
            if (deadlineTimer) clearTimeout(deadlineTimer)
            running -= 1
            startNext()
        })
    }

    return (request, options) => new Promise<ViewerEvidenceResult>((resolve, reject) => {
        const deadlineMs = options?.deadlineMs ?? DEFAULT_VIEWER_PROOF_DEADLINE_MS
        const waiter: Waiter = {
            request,
            deadlineMs,
            answer: resolve,
            fail: reject,
            timer: null,
            startedAt: Date.now(),
        }
        if (running < limits.maxConcurrent) {
            run(waiter)
            return
        }
        if (queue.length >= limits.maxQueued) {
            resolve(busy(`viewer runtime proof queue is full (${queue.length} waiting, ${running} running)`))
            return
        }
        const waitBudget = Math.min(limits.maxWaitMs, deadlineMs)
        waiter.timer = setTimeout(() => {
            const index = queue.indexOf(waiter)
            if (index === -1) return
            queue.splice(index, 1) // late queued work never starts
            resolve(busy(`viewer runtime proof waited longer than ${waitBudget}ms for a slot`))
        }, waitBudget)
        waiter.timer.unref?.()
        queue.push(waiter)
    })
}
