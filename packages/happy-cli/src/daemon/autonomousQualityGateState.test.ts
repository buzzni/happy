import { describe, expect, it } from 'vitest';

import {
    createAutonomousQualityGateState,
    reduceAutonomousQualityGateState,
    type AutonomousGateFailure,
} from './autonomousQualityGateState';

const failure: AutonomousGateFailure = {
    phase: 'test',
    exitCode: 1,
    timedOut: false,
};

describe('autonomous quality gate state', () => {
    it('passes only after the active gate attempt succeeds', () => {
        const initial = createAutonomousQualityGateState();
        const verifying = reduceAutonomousQualityGateState(initial, { type: 'gate-started' });

        expect(verifying).toEqual({ stage: 'verifying', attempt: 1, lastFailure: null });
        expect(reduceAutonomousQualityGateState(verifying, { type: 'gate-passed' })).toEqual({
            stage: 'passed',
            attempt: 1,
            lastFailure: null,
        });
    });

    it('feeds a failed gate back into repairing without losing its evidence', () => {
        const verifying = reduceAutonomousQualityGateState(
            createAutonomousQualityGateState(),
            { type: 'gate-started' },
        );

        expect(reduceAutonomousQualityGateState(verifying, { type: 'gate-failed', failure })).toEqual({
            stage: 'repairing',
            attempt: 1,
            lastFailure: failure,
        });
    });

    it('records an unchanged worktree after failure without starting another gate attempt', () => {
        const repairing = reduceAutonomousQualityGateState(
            { stage: 'verifying', attempt: 1, lastFailure: null },
            { type: 'gate-failed', failure },
        );

        expect(reduceAutonomousQualityGateState(repairing, { type: 'worktree-unchanged' })).toEqual({
            stage: 'unchanged-after-failure',
            attempt: 1,
            lastFailure: failure,
        });
    });

    it('stops from any active stage when a limit is reached', () => {
        for (const state of [
            createAutonomousQualityGateState(),
            { stage: 'verifying', attempt: 1, lastFailure: null } as const,
            { stage: 'repairing', attempt: 1, lastFailure: failure } as const,
            { stage: 'unchanged-after-failure', attempt: 1, lastFailure: failure } as const,
        ]) {
            expect(reduceAutonomousQualityGateState(state, {
                type: 'limit-reached',
                reason: 'max-continuations',
            })).toEqual({
                stage: 'limit-reached',
                attempt: state.attempt,
                lastFailure: state.lastFailure,
                limitReason: 'max-continuations',
            });
        }
    });

    it('does not revive a terminal passed or limit-reached run', () => {
        const passed = { stage: 'passed', attempt: 1, lastFailure: null } as const;
        const limited = {
            stage: 'limit-reached',
            attempt: 1,
            lastFailure: failure,
            limitReason: 'max-turns',
        } as const;

        expect(reduceAutonomousQualityGateState(passed, { type: 'gate-started' })).toBe(passed);
        expect(reduceAutonomousQualityGateState(limited, { type: 'gate-started' })).toBe(limited);
    });
});
