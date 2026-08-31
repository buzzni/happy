import { describe, expect, it, vi } from 'vitest';
import type { AutonomousQualityGatePhaseResult } from './autonomousQualityGateRunner';
import { runWithAutonomousFingerprintGuard } from './autonomousQualityGateFingerprint';

const passed: AutonomousQualityGatePhaseResult = {
    name: 'test',
    status: 'passed',
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    stdoutTail: 'ok',
    stderrTail: '',
    outputTruncated: false,
};

describe('runWithAutonomousFingerprintGuard', () => {
    it('accepts a gate result only while the worktree fingerprint remains current', async () => {
        const capture = vi.fn()
            .mockResolvedValueOnce({ digest: 'a', entryCount: 1, excludedCount: 0 })
            .mockResolvedValueOnce({ digest: 'a', entryCount: 1, excludedCount: 0 });

        await expect(runWithAutonomousFingerprintGuard({ capture, run: async () => passed }))
            .resolves.toEqual({
                status: 'accepted',
                fingerprint: { digest: 'a', entryCount: 1, excludedCount: 0 },
                result: passed,
            });
    });

    it('discards a passing result when a concurrent edit changes the fingerprint', async () => {
        const capture = vi.fn()
            .mockResolvedValueOnce({ digest: 'before', entryCount: 1, excludedCount: 0 })
            .mockResolvedValueOnce({ digest: 'after', entryCount: 1, excludedCount: 0 });

        const outcome = await runWithAutonomousFingerprintGuard({ capture, run: async () => passed });

        expect(outcome).toEqual({
            status: 'stale',
            before: { digest: 'before', entryCount: 1, excludedCount: 0 },
            after: { digest: 'after', entryCount: 1, excludedCount: 0 },
        });
        expect(outcome).not.toHaveProperty('result');
    });
});
