import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
export type StartDecision = { state: 'allowed'; validForMs: number } | { state: 'wait'; retryAfterMs: number; preferredAccountIds: string[] }
/** A turn retains its request identity through polling/response loss. Cancellation never authorizes execution. */
export async function waitForSetupTokenStart(deps: {
    request(requestId: string, signal: AbortSignal): Promise<StartDecision>;
    notify(): void;
    /** Another account has start budget left: true when the session moved there, so this account's wait ends unadmitted. */
    moveToPreferred?(): Promise<boolean>;
    moveFromExhausted?(): Promise<boolean>;
    signal: AbortSignal;
}): Promise<boolean> {
    const requestId = randomUUID();
    let notified = false;
    let waits = 0;
    try {
        while (!deps.signal.aborted) {
            const sentAt = performance.now();
            let decision: StartDecision;
            try { decision = await deps.request(requestId, deps.signal); }
            catch (error) {
                if (deps.signal.aborted) return false;
                if (error instanceof Error && error.message === 'SETUP_TOKEN_START_ACCOUNT_EXHAUSTED'
                    && deps.moveFromExhausted && await deps.moveFromExhausted()) return false;
                throw error;
            }
            if (deps.signal.aborted) return false;
            if (decision.state === 'allowed') {
                if (!Number.isFinite(decision.validForMs) || decision.validForMs <= performance.now() - sentAt) throw new Error('SETUP_TOKEN_START_EXPIRED');
                return true;
            }
            if (decision.preferredAccountIds.length && deps.moveToPreferred && await deps.moveToPreferred()) return false;
            if (deps.signal.aborted) return false;
            if (!notified) { notified = true; deps.notify(); }
            if (deps.signal.aborted) return false;
            if (!Number.isFinite(decision.retryAfterMs) || decision.retryAfterMs <= 0) throw new Error('SETUP_TOKEN_START_INVALID_WAIT');
            // Bound unattended recovery to 60 polls (normally 30 minutes); never dispatch without a permit.
            if (++waits >= 60) throw new Error('SETUP_TOKEN_START_WAIT_EXHAUSTED');
            // Recheck eligibility/capacity at most once per 30 seconds while waiting.
            await delay(Math.min(30_000, decision.retryAfterMs), undefined, { signal: deps.signal });
        }
        return false;
    } catch (error) {
        if (deps.signal.aborted) return false;
        throw error;
    }
}
/**
 * Saycode specs/shared-pc-start-budget — an unbound shared-PC turn waits only on a wait Studio answers: when no decision
 * can be had (daemon or Studio unreachable, an invalid or expired answer) the turn runs (decision D1). Cancellation
 * still never runs it.
 */
export async function waitForSharedSetupTokenStart(deps: Parameters<typeof waitForSetupTokenStart>[0]): Promise<boolean> {
    try { return await waitForSetupTokenStart(deps); }
    catch { return !deps.signal.aborted; }
}
