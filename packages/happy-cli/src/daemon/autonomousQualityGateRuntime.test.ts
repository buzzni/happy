import { describe, expect, it, vi } from 'vitest';
import type { AutonomousQualityGateStartRequestV1 } from '../api/autonomousQualityGateProtocol';
import { AutonomousQualityGateRuntime } from './autonomousQualityGateRuntime';

const request: AutonomousQualityGateStartRequestV1 = {
    schemaVersion: 1,
    requestId: 'start-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    directory: '/repo',
    recipeRevision: 'a'.repeat(64),
    plan: { phases: [{ name: 'test', command: 'npm test', timeoutMs: 1_000 }] },
    limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000, maxGateAttempts: 3 },
};

describe('AutonomousQualityGateRuntime', () => {
    it('accepts stale pause/stop safely but requires exact revision to resume', () => {
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-control',
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });

        expect(runtime.control('pause', 99)).toMatchObject({ accepted: true, status: { stage: 'paused' } });
        expect(runtime.control('resume', 0)).toMatchObject({ accepted: false, conflict: true, status: { stage: 'paused' } });
        const revision = runtime.getStatus().revision;
        expect(runtime.control('resume', revision)).toMatchObject({ accepted: true, status: { stage: 'awaiting-completion' } });
        expect(runtime.control('stop', 0)).toMatchObject({ accepted: true, status: { stage: 'stopped' } });
    });

    it('feeds a failed gate back into the same session and passes a changed completion candidate', async () => {
        let fingerprint = 'before';
        const sendRepair = vi.fn(async (_message: string) => {});
        const runPhase = vi.fn()
            .mockResolvedValueOnce({
                name: 'test',
                status: 'failed',
                exitCode: 1,
                timedOut: false,
                durationMs: 10,
                stdoutTail: 'TOKEN=hidden',
                stderrTail: 'fix this',
                outputTruncated: false,
            })
            .mockResolvedValueOnce({
                name: 'test',
                status: 'passed',
                exitCode: 0,
                timedOut: false,
                durationMs: 10,
                stdoutTail: 'ok',
                stderrTail: '',
                outputTruncated: false,
            });
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-1',
            now: () => 1_000,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase,
            sendRepair,
        });

        runtime.setSessionIdle(true);
        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({ stage: 'repairing', attempt: 1 });
        expect(sendRepair).toHaveBeenCalledOnce();
        expect(sendRepair.mock.calls[0][0]).toContain('<quality-gate-evidence>');
        expect(sendRepair.mock.calls[0][0]).not.toContain('hidden');

        fingerprint = 'after-edit';
        runtime.setSessionIdle(true);
        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({
            stage: 'passed',
            attempt: 2,
            nextAction: 'review',
            usage: { continuations: 1 },
        });
        expect(runPhase).toHaveBeenCalledTimes(2);
    });

    it('stops before a new gate when an assistant turn reaches a configured budget', async () => {
        const runtime = new AutonomousQualityGateRuntime({
            ...request,
            limits: { ...request.limits, maxTurns: 1 },
        }, {
            runId: 'run-2',
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });

        runtime.recordAssistantTurn({ total: 10 });
        runtime.setSessionIdle(true);

        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({ stage: 'limit-reached' });
    });
});
