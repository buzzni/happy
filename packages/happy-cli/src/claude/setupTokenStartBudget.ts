import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
export type StartDecision = { state: 'allowed'; validForMs: number } | { state: 'wait'; retryAfterMs: number; preferredAccountIds: string[] }
/** A turn retains its request identity through polling/response loss. Cancellation never authorizes execution. */
export async function waitForSetupTokenStart(deps: {
    request(requestId: string, signal: AbortSignal): Promise<StartDecision>;
    notify(): void;
    signal: AbortSignal;
}): Promise<boolean> {
    const requestId = randomUUID();
    let notified = false;
    try {
        while (!deps.signal.aborted) {
            const sentAt = performance.now();
            const decision = await deps.request(requestId, deps.signal);
            if (deps.signal.aborted) return false;
            if (decision.state === 'allowed') {
                if (!Number.isFinite(decision.validForMs) || decision.validForMs <= performance.now() - sentAt) throw new Error('SETUP_TOKEN_START_EXPIRED');
                return true;
            }
            if (!notified) { notified = true; deps.notify(); }
            if (deps.signal.aborted) return false;
            if (!Number.isFinite(decision.retryAfterMs) || decision.retryAfterMs <= 0) throw new Error('SETUP_TOKEN_START_INVALID_WAIT');
            // Recheck eligibility/capacity at most once per 30 seconds while waiting.
            await delay(Math.min(30_000, decision.retryAfterMs), undefined, { signal: deps.signal });
        }
        return false;
    } catch (error) {
        if (deps.signal.aborted) return false;
        throw error;
    }
}
