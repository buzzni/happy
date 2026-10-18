import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@/claude/sdk';
import {
    CLAUDE_TRANSIENT_RETRY_AFTER_CAP_MS,
    CLAUDE_TRANSIENT_RETRY_DELAYS_MS,
    classifyClaudeTurnFailure,
    createClaudeTransientRetry,
    type ClaudeTransientRetryState,
} from './claudeTransientRetry';

/*
 * Shapes recorded on 2026-10-18 from the Claude Code CLI bundled with
 * @anthropic-ai/claude-agent-sdk 0.3.285, pointed at a local server that
 * answered 503 / 529 / 400 or dropped the connection (CLAUDE_CODE_MAX_RETRIES=2).
 */
const apiRetry = (status: number | null, delayMs: number): SDKMessage => ({
    type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2, retry_delay_ms: delayMs,
    error_status: status, error: status === 529 ? 'overloaded' : status === null ? 'unknown' : 'server_error',
    session_id: 's', uuid: 'r-1',
} as unknown as SDKMessage);
const syntheticError = (text: string, error = 'server_error'): SDKMessage => ({
    type: 'assistant', error, is_api_error_message: true, parent_tool_use_id: null, session_id: 's', uuid: 'a-err',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
} as unknown as SDKMessage);
const failedResult = (status: number | null, extra: Record<string, unknown> = {}): SDKMessage => ({
    type: 'result', subtype: 'success', is_error: true, api_error_status: status, api_error: null,
    terminal_reason: 'api_error', result: `API Error: ${status}`, total_cost_usd: 0, num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0 }, session_id: 's', uuid: 'res-1', ...extra,
} as unknown as SDKMessage);
const okResult: SDKMessage = { type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: 's', uuid: 'res-ok' } as unknown as SDKMessage;
const assistantText: SDKMessage = {
    type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: 'a-1',
    message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }], usage: { input_tokens: 3, output_tokens: 2 } },
} as unknown as SDKMessage;
const assistantToolUse: SDKMessage = {
    type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: 'a-2',
    message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 3, output_tokens: 2 } },
} as unknown as SDKMessage;
const textDelta: SDKMessage = {
    type: 'stream_event', parent_tool_use_id: null, session_id: 's', uuid: 'se-1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Par' } },
} as unknown as SDKMessage;

/** Feeds one attempt's messages and returns what the last result was classified as. */
function classifyTurn(messages: SDKMessage[]) {
    const retry = createClaudeTransientRetry<string>({ onState: () => {} });
    for (const message of messages) retry.observe(message);
    return retry.pendingFailure();
}

describe('classifyClaudeTurnFailure', () => {
    it('shouldTreatServerErrorsOverloadAndTimeoutsAsTransient', () => {
        expect(classifyClaudeTurnFailure(failedResult(503))).toEqual({ reason: 'server_error', status: 503 });
        expect(classifyClaudeTurnFailure(failedResult(529))).toEqual({ reason: 'overloaded', status: 529 });
        expect(classifyClaudeTurnFailure(failedResult(408))).toEqual({ reason: 'timeout', status: 408 });
    });

    it('shouldTreatAFailureWithNoHttpResponseAsANetworkFailure', () => {
        expect(classifyClaudeTurnFailure(failedResult(null))).toEqual({ reason: 'network', status: null });
    });

    it('shouldNotRetryClientErrorsRateLimitsOrDeterministicApiErrors', () => {
        expect(classifyClaudeTurnFailure(failedResult(400))).toBeNull();
        expect(classifyClaudeTurnFailure(failedResult(401))).toBeNull();
        expect(classifyClaudeTurnFailure(failedResult(429))).toBeNull();
        expect(classifyClaudeTurnFailure(failedResult(500, { api_error: 'claude_code_version_too_old' }))).toBeNull();
    });

    it('shouldNotRetryWhenTheTurnEndedForAnotherReason', () => {
        expect(classifyClaudeTurnFailure(failedResult(null, { terminal_reason: 'aborted_streaming' }))).toBeNull();
        expect(classifyClaudeTurnFailure(okResult)).toBeNull();
        expect(classifyClaudeTurnFailure({ ...failedResult(null), subtype: 'error_during_execution' } as unknown as SDKMessage)).toBeNull();
    });

    it('shouldRequireAnHttpStatusFromCliVersionsThatDoNotReportATerminalReason', () => {
        const { terminal_reason: _ignored, ...older } = failedResult(503) as unknown as Record<string, unknown>;
        expect(classifyClaudeTurnFailure(older as unknown as SDKMessage)).toEqual({ reason: 'server_error', status: 503 });
        const { terminal_reason: _alsoIgnored, ...olderNetwork } = failedResult(null) as unknown as Record<string, unknown>;
        expect(classifyClaudeTurnFailure(olderNetwork as unknown as SDKMessage)).toBeNull();
    });
});

describe('turn observation', () => {
    it('shouldOfferARetryForAnAttemptThatProducedNothingButTheApiError', () => {
        expect(classifyTurn([apiRetry(503, 7_000), apiRetry(503, 7_000), syntheticError('API Error: 503'), failedResult(503)]))
            .toEqual({ reason: 'server_error', status: 503, hintMs: 7_000 });
    });

    it('shouldNotRetryATurnThatAlreadyShowedAnswerText', () => {
        expect(classifyTurn([assistantText, syntheticError('API Error: 503'), failedResult(503)])).toBeNull();
    });

    it('shouldNotRetryATurnThatStreamedTextIntoThePreview', () => {
        expect(classifyTurn([textDelta, syntheticError('API Error: Connection dropped'), failedResult(null)])).toBeNull();
    });

    it('shouldNotRetryATurnThatCalledATool', () => {
        expect(classifyTurn([assistantToolUse, syntheticError('API Error: 529'), failedResult(529)])).toBeNull();
    });

    it('shouldNotRetryAnAuthenticationOrCredentialFailureWithoutAStatus', () => {
        expect(classifyTurn([syntheticError('API Error: Could not load credentials', 'cloud_credential_error'), failedResult(null)])).toBeNull();
        expect(classifyTurn([syntheticError('Not logged in', 'authentication_failed'), failedResult(null)])).toBeNull();
    });

    it('shouldStartEachTurnWithAFreshObservation', () => {
        const retry = createClaudeTransientRetry<string>({ onState: () => {} });
        for (const message of [assistantText, okResult]) retry.observe(message);
        for (const message of [syntheticError('API Error: 503'), failedResult(503)]) retry.observe(message);
        expect(retry.pendingFailure()).toEqual({ reason: 'server_error', status: 503, hintMs: null });
    });

    it('shouldForgetATurnThatEndedWithoutAResultWhenTheNextOneStarts', () => {
        const retry = createClaudeTransientRetry<string>({ onState: () => {} });
        // Answered, then the provider was killed before its result.
        retry.observe(assistantText);
        retry.turnStarted();
        for (const message of [syntheticError('API Error: 503'), failedResult(503)]) retry.observe(message);
        expect(retry.pendingFailure()).toEqual({ reason: 'server_error', status: 503, hintMs: null });
    });
});

describe('createClaudeTransientRetry', () => {
    let states: Array<ClaudeTransientRetryState | null>;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        states = [];
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const fail = (retry: ReturnType<typeof createClaudeTransientRetry<string>>, status: number | null = 503, hint?: number) => {
        if (hint !== undefined) retry.observe(apiRetry(status, hint));
        retry.observe(syntheticError('API Error'));
        retry.observe(failedResult(status));
    };

    it('shouldWaitFifteenThirtyAndSixtySecondsPlusJitterForFiveAttempts', () => {
        const retry = createClaudeTransientRetry<string>({ onState: (s) => states.push(s), random: () => 0.5 });
        const waits: number[] = [];
        for (let attempt = 1; attempt <= 5; attempt++) {
            fail(retry);
            const outcome = retry.afterTurn('m');
            expect(outcome?.kind).toBe('scheduled');
            const state = outcome?.kind === 'scheduled' ? outcome.state : null;
            expect(state).toMatchObject({ provider: 'claude', attempt, maxAttempts: 5, reason: 'server_error', status: 503 });
            waits.push(state!.retryAt - state!.scheduledAt);
            vi.advanceTimersByTime(state!.retryAt - Date.now());
            expect(retry.takeDue()).toEqual({ mode: 'm', attempt });
        }
        // 10% jitter at random() = 0.5 on a 20% ratio.
        expect(waits).toEqual(CLAUDE_TRANSIENT_RETRY_DELAYS_MS.map(delay => Math.round(delay * 1.1)));
        fail(retry);
        expect(retry.afterTurn('m')).toEqual({ kind: 'exhausted', maxAttempts: 5 });
    });

    it('shouldHonourALongerProviderDelayUpToTwoMinutes', () => {
        const retry = createClaudeTransientRetry<string>({ onState: () => {}, random: () => 0 });
        fail(retry, 529, 90_000);
        const longer = retry.afterTurn('m');
        expect(longer?.kind === 'scheduled' && longer.state.retryAt - longer.state.scheduledAt).toBe(90_000);
        retry.cancel();
        fail(retry, 529, 600_000);
        const capped = retry.afterTurn('m');
        expect(capped?.kind === 'scheduled' && capped.state.retryAt - capped.state.scheduledAt).toBe(CLAUDE_TRANSIENT_RETRY_AFTER_CAP_MS);
    });

    it('shouldNotLetAShortCliBackoffShortenTheSchedule', () => {
        const retry = createClaudeTransientRetry<string>({ onState: () => {}, random: () => 0 });
        fail(retry, null, 615);
        const outcome = retry.afterTurn('m');
        expect(outcome?.kind === 'scheduled' && outcome.state.retryAt - outcome.state.scheduledAt).toBe(15_000);
    });

    it('shouldAbortTheWaitSignalWhenTheRetryIsDueAndHandItOutOnce', () => {
        const retry = createClaudeTransientRetry<string>({ onState: (s) => states.push(s), random: () => 0 });
        fail(retry);
        retry.afterTurn('m');
        const signal = retry.waitSignal();
        expect(signal?.aborted).toBe(false);
        expect(retry.takeDue()).toBeNull();
        vi.advanceTimersByTime(15_000);
        expect(signal?.aborted).toBe(true);
        expect(retry.takeDue()).toEqual({ mode: 'm', attempt: 1 });
        expect(retry.takeDue()).toBeNull();
        expect(retry.waitSignal()).toBeNull();
        expect(states.at(-1)).toBeNull();
    });

    it('shouldNeverHandOutARetryCancelledAfterItBecameDue', () => {
        // Barrier: the timer has fired, the waiter has not yet collected it, and the user acts.
        const retry = createClaudeTransientRetry<string>({ onState: (s) => states.push(s), random: () => 0 });
        fail(retry);
        retry.afterTurn('m');
        vi.advanceTimersByTime(15_000);
        expect(retry.cancel()).toBe(true);
        expect(retry.takeDue()).toBeNull();
        expect(states.at(-1)).toBeNull();
    });

    it('shouldCancelAWaitingRetryWithoutEverFiringIt', () => {
        const retry = createClaudeTransientRetry<string>({ onState: (s) => states.push(s), random: () => 0 });
        fail(retry);
        retry.afterTurn('m');
        const signal = retry.waitSignal();
        expect(retry.cancel()).toBe(true);
        // The waiter is woken, but there is nothing to collect.
        expect(signal?.aborted).toBe(true);
        vi.advanceTimersByTime(60_000);
        expect(retry.takeDue()).toBeNull();
        expect(retry.cancel()).toBe(false);
        expect(states).toEqual([expect.objectContaining({ attempt: 1 }), null]);
    });

    it('shouldRestoreTheBudgetWhenTheUserStartsATurnOrATurnEndsAnotherWay', () => {
        const retry = createClaudeTransientRetry<string>({ onState: () => {}, random: () => 0 });
        fail(retry);
        retry.afterTurn('m');
        retry.userTurnStarted();
        fail(retry);
        expect(retry.afterTurn('m')).toMatchObject({ kind: 'scheduled', state: { attempt: 1 } });
        vi.advanceTimersByTime(15_000);
        retry.takeDue();
        retry.observe(okResult);
        expect(retry.afterTurn('m')).toBeNull();
        fail(retry);
        expect(retry.afterTurn('m')).toMatchObject({ kind: 'scheduled', state: { attempt: 1 } });
    });

    it('shouldNotScheduleATurnTheCallerMayNotRetry', () => {
        const retry = createClaudeTransientRetry<string>({ onState: (s) => states.push(s) });
        fail(retry);
        expect(retry.afterTurn(null)).toBeNull();
        expect(retry.waitSignal()).toBeNull();
        expect(states).toEqual([]);
    });
});
