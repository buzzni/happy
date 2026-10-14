/**
 * Automatic continuation after a Codex turn dies with "Selected model is at capacity".
 *
 * Codex does not retry `serverOverloaded`: one sampling request that comes back at
 * capacity — often several tool calls into a turn — ends the whole turn as failed.
 * The overload is usually momentary, so the host continues the same thread after a
 * short wait instead of leaving the user to type "continue" by hand.
 */

/** Waits before each automatic continuation; the length is the retry budget. */
export const CODEX_CAPACITY_RETRY_DELAYS_MS = [5_000, 20_000] as const;

export const CODEX_CAPACITY_CONTINUE_PROMPT =
    'The previous attempt stopped because the model was temporarily at capacity. '
    + 'Continue the task from where you left off; do not repeat work that is already done.';

export function isCodexServerOverloadedFailure(msg: unknown): boolean {
    const event = msg as { type?: unknown; status?: unknown; error?: { codexErrorInfo?: unknown } } | null;
    return event?.type === 'task_complete'
        && event.status === 'failed'
        && event.error?.codexErrorInfo === 'serverOverloaded';
}

export type CodexCapacityRetry = { attempt: number; maxAttempts: number; delayMs: number };

/**
 * Budget per user request: a turn that ends any other way restores it, and so does a
 * new user message, so a long session never runs out because of earlier overloads.
 */
export function createCodexCapacityRetryPolicy(delaysMs: readonly number[] = CODEX_CAPACITY_RETRY_DELAYS_MS) {
    let attempts = 0;
    return {
        afterTurn(serverOverloaded: boolean): CodexCapacityRetry | null {
            if (!serverOverloaded) {
                attempts = 0;
                return null;
            }
            if (attempts >= delaysMs.length) return null;
            attempts += 1;
            return { attempt: attempts, maxAttempts: delaysMs.length, delayMs: delaysMs[attempts - 1] };
        },
        reset(): void {
            attempts = 0;
        },
    };
}
