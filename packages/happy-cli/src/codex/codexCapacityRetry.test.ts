import { describe, expect, it } from 'vitest';
import {
    CODEX_CAPACITY_RETRY_DELAYS_MS,
    createCodexCapacityRetryPolicy,
    isCodexServerOverloadedFailure,
} from './codexCapacityRetry';

// Verbatim shape of the event a happy-codex session received on 2026-10-12 when
// one sampling request mid-turn came back "at capacity" and the whole turn ended.
const OVERLOADED_TASK_COMPLETE = {
    type: 'task_complete',
    turn_id: '01a1300d-4fdc-7b62-a6da-b3c4e99a4765',
    status: 'failed',
    error: {
        message: 'Selected model is at capacity. Please try a different model.',
        codexErrorInfo: 'serverOverloaded',
        additionalDetails: null,
        misalignment: null,
    },
};

describe('isCodexServerOverloadedFailure', () => {
    it('shouldRecognizeTheServerOverloadedTaskCompleteCodexSends', () => {
        expect(isCodexServerOverloadedFailure(OVERLOADED_TASK_COMPLETE)).toBe(true);
    });

    it('shouldIgnoreOtherProviderErrors', () => {
        expect(isCodexServerOverloadedFailure({
            ...OVERLOADED_TASK_COMPLETE,
            error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' },
        })).toBe(false);
    });

    it('shouldIgnoreSuccessfulTurns', () => {
        expect(isCodexServerOverloadedFailure({ type: 'task_complete', status: 'completed' })).toBe(false);
    });

    it('shouldIgnoreTurnsTheUserAborted', () => {
        expect(isCodexServerOverloadedFailure({ ...OVERLOADED_TASK_COMPLETE, type: 'turn_aborted' })).toBe(false);
    });
});

describe('createCodexCapacityRetryPolicy', () => {
    it('shouldRetryWithIncreasingDelaysUntilTheBudgetIsSpent', () => {
        const policy = createCodexCapacityRetryPolicy();

        const first = policy.afterTurn(true);
        const second = policy.afterTurn(true);
        const third = policy.afterTurn(true);

        expect(first).toEqual({ attempt: 1, maxAttempts: 2, delayMs: CODEX_CAPACITY_RETRY_DELAYS_MS[0] });
        expect(second).toEqual({ attempt: 2, maxAttempts: 2, delayMs: CODEX_CAPACITY_RETRY_DELAYS_MS[1] });
        expect(third).toBeNull();
        expect(CODEX_CAPACITY_RETRY_DELAYS_MS[1]).toBeGreaterThan(CODEX_CAPACITY_RETRY_DELAYS_MS[0]);
    });

    it('shouldNotRetryATurnThatDidNotFailFromCapacity', () => {
        expect(createCodexCapacityRetryPolicy().afterTurn(false)).toBeNull();
    });

    it('shouldRestoreTheFullBudgetAfterATurnSucceeds', () => {
        const policy = createCodexCapacityRetryPolicy();
        policy.afterTurn(true);
        policy.afterTurn(true);

        policy.afterTurn(false);

        expect(policy.afterTurn(true)?.attempt).toBe(1);
    });

    it('shouldRestoreTheFullBudgetWhenTheUserSendsANewMessage', () => {
        const policy = createCodexCapacityRetryPolicy();
        policy.afterTurn(true);
        policy.afterTurn(true);
        expect(policy.afterTurn(true)).toBeNull();

        policy.reset();

        expect(policy.afterTurn(true)?.attempt).toBe(1);
    });
});
