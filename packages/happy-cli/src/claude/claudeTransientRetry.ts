/**
 * Automatic retry of a Claude turn that a temporary API failure ended before it produced anything.
 *
 * Claude Code retries a failing request itself (`system/api_retry`) and, once its own budget is
 * spent, ends the turn with a synthetic "API Error: …" message and an `is_error` result. When that
 * failure is the provider being temporarily away (5xx, 529, timeouts, a dropped connection) and the
 * user has seen nothing of an answer yet, the host waits and asks the same conversation to answer
 * again instead of leaving the user to retype the request.
 *
 * Design reference: hermes-agent `agent/turn_recovery_autorecover.py` (MIT, Nous Research) —
 * the 15/30/60/60/60 s jittered ladder and the 120 s Retry-After cap. Saycode
 * specs/claude-transient-retry records the measured CLI shapes and the decisions (D1–D7).
 */
import type { SDKMessage } from '@/claude/sdk';
import type { AgentTransientRetry } from '@/api/types';

/** Waits before each automatic retry; the length is the retry budget. */
export const CLAUDE_TRANSIENT_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 60_000, 60_000] as const;
/** Each wait is lengthened by up to this fraction, so sessions hit by the same outage spread out. */
export const CLAUDE_TRANSIENT_RETRY_JITTER_RATIO = 0.2;
/** A provider-requested delay longer than the ladder is honoured up to this much. */
export const CLAUDE_TRANSIENT_RETRY_AFTER_CAP_MS = 120_000;

/**
 * Sent instead of the original request: Claude Code already saved that request to the
 * conversation before the failing call, and merges this note into the same user message, so
 * resending the request itself would show the model the request twice.
 */
export const CLAUDE_TRANSIENT_CONTINUE_PROMPT =
    '(Automatic retry: the previous attempt failed with a temporary API error before any reply. '
    + 'Please respond to the request above.)';

/** Published as `agentState.transientRetry` while a retry waits; `null` once it ran or was cancelled. */
export type ClaudeTransientRetryState = AgentTransientRetry;

export type ClaudeTransientFailure = Pick<AgentTransientRetry, 'reason' | 'status'>;

export type ClaudeTransientRetryOutcome =
    | { kind: 'scheduled'; state: ClaudeTransientRetryState }
    | { kind: 'exhausted'; maxAttempts: number };

/** Assistant error classes that are deterministic for the request, whatever the status says. */
const NON_TRANSIENT_ASSISTANT_ERRORS = new Set([
    'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required',
    'billing_error', 'rate_limit', 'invalid_request', 'model_not_found', 'max_output_tokens',
    'cloud_credential_error',
]);

/**
 * The transient class of a turn's final result, or `null` when the turn should not be retried.
 *
 * A result without `terminal_reason` comes from an older CLI; only an HTTP status proves there
 * that the turn died on the API, so a status-less failure is retried only when the CLI says so.
 */
export function classifyClaudeTurnFailure(message: SDKMessage): ClaudeTransientFailure | null {
    const result = message as {
        type?: unknown; subtype?: unknown; is_error?: unknown; terminal_reason?: unknown;
        api_error_status?: unknown; api_error?: unknown;
    };
    if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== true) return null;
    if (result.api_error !== undefined && result.api_error !== null) return null;
    if (result.terminal_reason !== undefined && result.terminal_reason !== 'api_error') return null;
    const status = typeof result.api_error_status === 'number' ? result.api_error_status : null;
    if (status === null) {
        return result.terminal_reason === 'api_error' ? { reason: 'network', status: null } : null;
    }
    if (status === 529) return { reason: 'overloaded', status };
    if (status === 408) return { reason: 'timeout', status };
    if (status >= 500 && status <= 599) return { reason: 'server_error', status };
    return null;
}

/** Whether a provider message shows the user something of an answer, or starts work. */
function producesOutput(message: SDKMessage): boolean {
    const m = message as {
        type?: unknown; is_api_error_message?: unknown; parent_tool_use_id?: unknown;
        event?: { type?: unknown }; message?: { content?: unknown };
    };
    if (m.parent_tool_use_id !== undefined && m.parent_tool_use_id !== null) return true;
    if (m.type === 'assistant') return m.is_api_error_message !== true;
    if (m.type === 'stream_event') {
        return m.event?.type === 'content_block_start' || m.event?.type === 'content_block_delta';
    }
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
        return m.message.content.some((block) => (block as { type?: unknown })?.type === 'tool_result');
    }
    return false;
}

/**
 * One session's retry ladder.
 *
 * `observe` sees every provider message (stream events included). At the turn boundary the
 * launcher calls `afterTurn`, then waits for input on `waitSignal()` alongside its queue: the
 * signal aborts when the retry is due or cancelled, and `takeDue` hands a due retry out exactly
 * once. Anything the user does first — a message, a stop — wins and cancels it.
 */
export function createClaudeTransientRetry<Mode>(deps: {
    onState: (state: ClaudeTransientRetryState | null) => void;
    delaysMs?: readonly number[];
    random?: () => number;
}) {
    const delaysMs = deps.delaysMs ?? CLAUDE_TRANSIENT_RETRY_DELAYS_MS;
    const random = deps.random ?? Math.random;
    let turnProducedOutput = false;
    let turnDeterministicError = false;
    let turnHintMs: number | null = null;
    let lastFailure: (ClaudeTransientFailure & { hintMs: number | null }) | null = null;
    let attempts = 0;
    let waiting: {
        mode: Mode;
        attempt: number;
        timer: ReturnType<typeof setTimeout>;
        wake: AbortController;
        due: boolean;
    } | null = null;

    const resetTurn = () => {
        turnProducedOutput = false;
        turnDeterministicError = false;
        turnHintMs = null;
    };

    const clearWaiting = (): boolean => {
        if (!waiting) return false;
        clearTimeout(waiting.timer);
        waiting.wake.abort();
        waiting = null;
        deps.onState(null);
        return true;
    };

    return {
        observe(message: SDKMessage): void {
            if (producesOutput(message)) turnProducedOutput = true;
            const error = (message as { is_api_error_message?: unknown; error?: unknown });
            if (message.type === 'assistant' && error.is_api_error_message === true
                && typeof error.error === 'string' && NON_TRANSIENT_ASSISTANT_ERRORS.has(error.error)) {
                turnDeterministicError = true;
            }
            const retry = message as { type?: unknown; subtype?: unknown; retry_delay_ms?: unknown };
            if (retry.type === 'system' && retry.subtype === 'api_retry' && typeof retry.retry_delay_ms === 'number') {
                turnHintMs = retry.retry_delay_ms;
            }
            if (message.type !== 'result') return;
            const failure = turnProducedOutput || turnDeterministicError ? null : classifyClaudeTurnFailure(message);
            lastFailure = failure ? { ...failure, hintMs: turnHintMs } : null;
            resetTurn();
        },

        /** A turn was dispatched: what a turn that ended without a result left behind is not this one's. */
        turnStarted(): void {
            resetTurn();
            lastFailure = null;
        },

        /** The retryable failure the last result reported, if any. */
        pendingFailure() {
            return lastFailure;
        },

        /**
         * The turn has ended. Schedules a retry, run as `retryAs`, when it ended on a retryable
         * failure; `null` means this turn may not be retried. Restores the budget otherwise.
         */
        afterTurn(retryAs: Mode | null): ClaudeTransientRetryOutcome | null {
            const failure = lastFailure;
            lastFailure = null;
            clearWaiting();
            if (!failure || retryAs === null) {
                attempts = 0;
                return null;
            }
            if (attempts >= delaysMs.length) {
                // Reported once; later failures stay quiet until the user acts or a turn succeeds.
                const first = attempts === delaysMs.length;
                attempts = delaysMs.length + 1;
                return first ? { kind: 'exhausted', maxAttempts: delaysMs.length } : null;
            }
            attempts += 1;
            const scheduled = delaysMs[attempts - 1];
            const jittered = Math.round(scheduled + random() * CLAUDE_TRANSIENT_RETRY_JITTER_RATIO * scheduled);
            const hinted = failure.hintMs === null ? 0 : Math.min(failure.hintMs, CLAUDE_TRANSIENT_RETRY_AFTER_CAP_MS);
            const delayMs = Math.max(jittered, hinted);
            const scheduledAt = Date.now();
            const state: ClaudeTransientRetryState = {
                provider: 'claude',
                attempt: attempts,
                maxAttempts: delaysMs.length,
                reason: failure.reason,
                status: failure.status,
                scheduledAt,
                retryAt: scheduledAt + delayMs,
            };
            const entry = {
                mode: retryAs,
                attempt: attempts,
                wake: new AbortController(),
                due: false,
                timer: setTimeout(() => {
                    entry.due = true;
                    entry.wake.abort();
                }, delayMs),
            };
            waiting = entry;
            deps.onState(state);
            return { kind: 'scheduled', state };
        },

        /** Aborts when the waiting retry becomes due or is cancelled; `null` when none waits. */
        waitSignal(): AbortSignal | null {
            return waiting?.wake.signal ?? null;
        },

        /** The due retry, handed out once. */
        takeDue(): { mode: Mode; attempt: number } | null {
            if (!waiting?.due) return null;
            const { mode, attempt } = waiting;
            clearWaiting();
            return { mode, attempt };
        },

        /** Drops a waiting retry. Returns whether one was waiting. */
        cancel(): boolean {
            return clearWaiting();
        },

        /** The user's own input became a turn: it replaces any waiting retry and restores the budget. */
        userTurnStarted(): void {
            clearWaiting();
            attempts = 0;
        },
    };
}

export type ClaudeTransientRetry<Mode> = ReturnType<typeof createClaudeTransientRetry<Mode>>;
