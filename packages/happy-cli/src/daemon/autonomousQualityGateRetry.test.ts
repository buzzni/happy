import { describe, expect, it, vi } from 'vitest';
import type { AutonomousQualityGatePhaseResult } from './autonomousQualityGateRunner';
import { runAutonomousQualityGateAttempt } from './autonomousQualityGateRetry';

const failed: AutonomousQualityGatePhaseResult = {
    name: 'test',
    status: 'failed',
    exitCode: 1,
    timedOut: false,
    durationMs: 10,
    stdoutTail: '',
    stderrTail: 'failed',
    outputTruncated: false,
};

describe('runAutonomousQualityGateAttempt', () => {
    it('suppresses unchanged worktrees and consumes an attempt without invoking a command', async () => {
        const runPhase = vi.fn();
        const outcome = await runAutonomousQualityGateAttempt({
            plan: { phases: [{ name: 'test', command: 'npm test', timeoutMs: 1_000 }] },
            previousFailure: { attempt: 1, fingerprint: 'same', result: failed },
            maxGateAttempts: 3,
            capture: async () => ({ digest: 'same', entryCount: 1, excludedCount: 0 }),
            runPhase,
        });

        expect(outcome).toEqual({
            status: 'unchanged-after-failure',
            attempt: 2,
            fingerprint: 'same',
            previousResult: failed,
        });
        expect(runPhase).not.toHaveBeenCalled();
    });

    it('reports exhaustion at the exact attempt boundary without rerunning', async () => {
        const runPhase = vi.fn();
        const outcome = await runAutonomousQualityGateAttempt({
            plan: { phases: [{ name: 'test', command: 'npm test', timeoutMs: 1_000 }] },
            previousFailure: { attempt: 2, fingerprint: 'same', result: failed },
            maxGateAttempts: 3,
            capture: async () => ({ digest: 'same', entryCount: 1, excludedCount: 0 }),
            runPhase,
        });

        expect(outcome).toMatchObject({ status: 'retry-exhausted', attempt: 3, fingerprint: 'same' });
        expect(runPhase).not.toHaveBeenCalled();
    });

    it('runs once after a real edit and records the new failure fingerprint', async () => {
        const runPhase = vi.fn(async () => failed);
        const capture = vi.fn()
            .mockResolvedValueOnce({ digest: 'changed', entryCount: 1, excludedCount: 0 })
            .mockResolvedValueOnce({ digest: 'changed', entryCount: 1, excludedCount: 0 });

        const outcome = await runAutonomousQualityGateAttempt({
            plan: { phases: [{ name: 'test', command: 'npm test', timeoutMs: 1_000 }] },
            previousFailure: { attempt: 1, fingerprint: 'old', result: failed },
            maxGateAttempts: 3,
            capture,
            runPhase,
        });

        expect(outcome).toEqual({ status: 'failed', attempt: 2, fingerprint: 'changed', result: failed });
        expect(runPhase).toHaveBeenCalledOnce();
    });
});
