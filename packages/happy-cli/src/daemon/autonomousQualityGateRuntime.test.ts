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

    it('clears terminal reason fields when user stop takes precedence', () => {
        const dependencies = {
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        };
        const blocked = new AutonomousQualityGateRuntime(request, {
            ...dependencies,
            runId: 'run-blocked-stop',
        });
        blocked.block('runtime-error');
        const stoppedBlocked = blocked.control('stop', 0).status;

        const limited = new AutonomousQualityGateRuntime({
            ...request,
            limits: { ...request.limits, maxTokens: 1 },
        }, {
            ...dependencies,
            runId: 'run-limited-stop',
        });
        limited.recordSessionUsage({ tokens: 1 });
        const stoppedLimited = limited.control('stop', 0).status;

        expect(stoppedBlocked).toMatchObject({ stage: 'stopped', nextAction: 'none' });
        expect(stoppedBlocked).not.toHaveProperty('blockedReason');
        expect(stoppedLimited).toMatchObject({ stage: 'stopped', nextAction: 'none' });
        expect(stoppedLimited).not.toHaveProperty('limitReason');
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
        expect(JSON.stringify(runtime.snapshot().previousFailure)).not.toContain('hidden');

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

        runtime.recordSessionUsage({ turns: 1, tokens: 10 });
        runtime.setSessionIdle(true);

        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({ stage: 'limit-reached' });
    });

    it('enters limit-reached as soon as a runtime report exhausts the budget', () => {
        const runtime = new AutonomousQualityGateRuntime({
            ...request,
            limits: { ...request.limits, maxTokens: 10 },
        }, {
            runId: 'run-live-budget',
            now: () => 1_000,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });

        expect(runtime.recordSessionUsage({ tokens: 10 })).toBe(true);
        expect(runtime.getStatus()).toMatchObject({
            stage: 'limit-reached',
            limitReason: 'max-tokens',
            nextAction: 'none',
            usage: { tokens: 10 },
        });
    });

    it('keeps limit-reached when a live budget report aborts an in-flight gate', async () => {
        let phaseStarted!: () => void;
        const started = new Promise<void>(resolve => { phaseStarted = resolve; });
        const runtime = new AutonomousQualityGateRuntime({
            ...request,
            limits: { ...request.limits, maxTokens: 10 },
        }, {
            runId: 'run-inflight-budget',
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: async (_phase, signal) => {
                phaseStarted();
                await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
                return {
                    name: 'test', status: 'aborted', exitCode: null, timedOut: false, durationMs: 1,
                    stdoutTail: '', stderrTail: '', outputTruncated: false,
                };
            },
            sendRepair: vi.fn(),
        });
        runtime.setSessionIdle(true);

        const completion = runtime.onCompletionCandidate();
        await started;
        runtime.recordSessionUsage({ tokens: 10 });

        await expect(completion).resolves.toMatchObject({
            stage: 'limit-reached',
            limitReason: 'max-tokens',
            nextAction: 'none',
        });
    });

    it('fails closed when gate infrastructure throws instead of remaining verifying', async () => {
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-gate-error',
            now: () => 1_000,
            capture: async () => { throw new Error('git unavailable'); },
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });
        runtime.setSessionIdle(true);

        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({
            stage: 'blocked',
            blockedReason: 'runtime-error',
            nextAction: 'none',
        });
    });

    it('fails closed when repair delivery throws instead of remaining verifying', async () => {
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-repair-error',
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            }),
            sendRepair: async () => { throw new Error('session unavailable'); },
        });
        runtime.setSessionIdle(true);

        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({
            stage: 'blocked',
            blockedReason: 'repair-delivery-failed',
            nextAction: 'none',
        });
    });

    it('does not overwrite a user pause while repair delivery is in flight', async () => {
        let repairStarted!: () => void;
        let finishRepair!: () => void;
        const started = new Promise<void>(resolve => { repairStarted = resolve; });
        const pendingRepair = new Promise<void>(resolve => { finishRepair = resolve; });
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-pause-during-repair',
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            }),
            sendRepair: async () => {
                repairStarted();
                await pendingRepair;
            },
        });
        runtime.setSessionIdle(true);

        const completion = runtime.onCompletionCandidate();
        await started;
        runtime.control('pause', 0);
        finishRepair();

        const paused = await completion;
        expect(paused).toMatchObject({
            stage: 'paused',
            nextAction: 'resume',
            usage: { continuations: 1 },
        });
        expect(runtime.control('resume', paused.revision)).toMatchObject({
            accepted: true,
            status: { stage: 'repairing' },
        });
    });

    it('resumes to retry when a paused repair delivery fails', async () => {
        let repairStarted!: () => void;
        let failRepair!: () => void;
        const started = new Promise<void>(resolve => { repairStarted = resolve; });
        const failedRepair = new Promise<void>((_resolve, reject) => {
            failRepair = () => reject(new Error('session unavailable'));
        });
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-pause-during-failed-repair',
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            }),
            sendRepair: async () => {
                repairStarted();
                await failedRepair;
            },
        });
        runtime.setSessionIdle(true);

        const completion = runtime.onCompletionCandidate();
        await started;
        runtime.control('pause', 0);
        failRepair();

        const paused = await completion;
        expect(paused).toMatchObject({ stage: 'paused', usage: { continuations: 0 } });
        expect(runtime.control('resume', paused.revision)).toMatchObject({
            accepted: true,
            status: { stage: 'awaiting-completion' },
        });
    });

    it('keeps the repair wait when pause and resume both occur during successful delivery', async () => {
        let repairStarted!: () => void;
        let finishRepair!: () => void;
        const started = new Promise<void>(resolve => { repairStarted = resolve; });
        const pendingRepair = new Promise<void>(resolve => { finishRepair = resolve; });
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-resume-during-repair',
            now: () => 1_000,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            }),
            sendRepair: async () => {
                repairStarted();
                await pendingRepair;
            },
        });
        runtime.setSessionIdle(true);

        const completion = runtime.onCompletionCandidate();
        await started;
        const paused = runtime.control('pause', 0).status;
        expect(runtime.control('resume', paused.revision)).toMatchObject({
            accepted: true,
            status: { stage: 'repairing' },
        });
        finishRepair();

        await expect(completion).resolves.toMatchObject({
            stage: 'repairing',
            usage: { continuations: 1 },
        });
    });

    it('charges only new assistant turns and provider tokens from cumulative session usage', () => {
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-usage',
            now: () => 1_000,
            initialSessionUsage: { turns: 7, tokens: 1_000 },
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });

        expect(runtime.recordSessionUsage({ turns: 7, tokens: 1_000 })).toBe(false);
        expect(runtime.recordSessionUsage({ turns: 8, tokens: 1_250 })).toBe(true);
        expect(runtime.recordSessionUsage({ turns: 8, tokens: 1_250 })).toBe(false);
        expect(runtime.getStatus().usage).toMatchObject({ turns: 1, tokens: 250 });
        expect(runtime.snapshot()).toMatchObject({ reportedTurns: 8, reportedTokens: 1_250 });
    });

    it('charges independently reported turn and token counters', () => {
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-partial-usage',
            now: () => 1_000,
            initialSessionUsage: { turns: 7, tokens: 1_000 },
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });

        expect(runtime.recordSessionUsage({ turns: 8 })).toBe(true);
        expect(runtime.recordSessionUsage({ tokens: 1_250 })).toBe(true);
        expect(runtime.getStatus().usage).toMatchObject({ turns: 1, tokens: 250 });
        expect(runtime.snapshot()).toMatchObject({ reportedTurns: 8, reportedTokens: 1_250 });
    });

    it('advances input admission for pause and stop even with stale revisions', () => {
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-control-epoch',
            now: () => 1_000,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });

        runtime.control('pause', 99);
        expect(runtime.snapshot().inputEpoch).toBe(1);
        runtime.control('stop', 99);
        expect(runtime.snapshot().inputEpoch).toBe(2);
    });

    it('checkpoints verifying before starting a gate effect', async () => {
        const order: string[] = [];
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-checkpoint',
            now: () => 1_000,
            checkpoint: async () => { order.push(`checkpoint:${runtime.getStatus().stage}`); },
            capture: async () => {
                order.push('capture');
                return { digest: 'same', entryCount: 0, excludedCount: 0 };
            },
            runPhase: async () => ({
                name: 'test', status: 'passed', exitCode: 0, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: '', outputTruncated: false,
            }),
            sendRepair: vi.fn(),
        });
        runtime.setSessionIdle(true);

        await runtime.onCompletionCandidate();

        expect(order).toEqual(['checkpoint:verifying', 'capture', 'capture']);
    });

    it('restores an interrupted gate as blocked and never guesses a replay', async () => {
        const runPhase = vi.fn();
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-interrupted',
            now: () => 1_000,
            restored: {
                status: {
                    schemaVersion: 1, runId: 'run-interrupted', revision: 3,
                    sessionId: 'session-1', projectId: 'project-1', stage: 'verifying', attempt: 1,
                    usage: { continuations: 0, turns: 0, tokens: 0, elapsedMs: 10 },
                    limits: request.limits, fingerprintChanged: null, nextAction: 'wait',
                },
                startedAt: 990,
                inputEpoch: 0,
                reportedTurns: 0,
                reportedTokens: 0,
            },
            capture: vi.fn(),
            runPhase,
            sendRepair: vi.fn(),
        });
        runtime.setSessionIdle(true);

        expect(runtime.getStatus()).toMatchObject({
            stage: 'blocked', blockedReason: 'interrupted-operation', nextAction: 'none',
        });
        await runtime.onCompletionCandidate();
        expect(runPhase).not.toHaveBeenCalled();
    });

    it('reports fingerprint change against the previous failure before replacing it', async () => {
        let fingerprint = 'before';
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-fingerprint-status',
            now: () => 1_000,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            }),
            sendRepair: vi.fn(async () => undefined),
        });
        runtime.setSessionIdle(true);

        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({ fingerprintChanged: null });
        fingerprint = 'after-edit';
        runtime.setSessionIdle(true);
        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({ fingerprintChanged: true });
    });

    it('clears a stale fingerprint verdict when a new gate candidate starts', async () => {
        let phaseStarted!: () => void;
        let finishPhase!: () => void;
        const started = new Promise<void>(resolve => { phaseStarted = resolve; });
        const phase = new Promise<{
            name: 'test'; status: 'passed'; exitCode: 0; timedOut: false;
            durationMs: 1; stdoutTail: ''; stderrTail: ''; outputTruncated: false;
        }>(resolve => {
            finishPhase = () => resolve({
                name: 'test', status: 'passed', exitCode: 0, timedOut: false,
                durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
            });
        });
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-after-stale',
            now: () => 2_000,
            restored: {
                status: {
                    schemaVersion: 1, runId: 'run-after-stale', revision: 3,
                    sessionId: 'session-1', projectId: 'project-1', stage: 'awaiting-completion', attempt: 1,
                    usage: { continuations: 0, turns: 0, tokens: 0, elapsedMs: 1_000 },
                    limits: request.limits, fingerprintChanged: true, nextAction: 'wait',
                },
                startedAt: 1_000,
                inputEpoch: 0,
                reportedTurns: 0,
                reportedTokens: 0,
            },
            capture: async () => ({ digest: 'current', entryCount: 1, excludedCount: 0 }),
            runPhase: async () => {
                phaseStarted();
                return phase;
            },
            sendRepair: vi.fn(),
        });
        runtime.setSessionIdle(true);

        const completion = runtime.onCompletionCandidate();
        await started;
        expect(runtime.getStatus()).toMatchObject({ stage: 'verifying', fingerprintChanged: null });
        runtime.control('pause', runtime.getStatus().revision);
        finishPhase();
        await completion;
        const paused = runtime.getStatus();
        expect(runtime.control('resume', paused.revision)).toMatchObject({
            accepted: true,
            status: { stage: 'awaiting-completion', fingerprintChanged: null },
        });
    });

    it('does not admit a completion candidate while paused', async () => {
        const runPhase = vi.fn();
        const runtime = new AutonomousQualityGateRuntime(request, {
            runId: 'run-paused',
            now: () => 1_000,
            capture: vi.fn(),
            runPhase,
            sendRepair: vi.fn(),
        });
        runtime.setSessionIdle(true);
        runtime.control('pause', 0);

        await expect(runtime.onCompletionCandidate()).resolves.toMatchObject({ stage: 'paused' });
        expect(runPhase).not.toHaveBeenCalled();
    });

    it('restores the pre-pause repair stage across daemon restart', () => {
        const restored = new AutonomousQualityGateRuntime(request, {
            runId: 'run-paused-restart',
            now: () => 2_000,
            restored: {
                status: {
                    schemaVersion: 1, runId: 'run-paused-restart', revision: 4,
                    sessionId: 'session-1', projectId: 'project-1', stage: 'paused', attempt: 1,
                    usage: { continuations: 1, turns: 1, tokens: 10, elapsedMs: 1_000 },
                    limits: request.limits, fingerprintChanged: false, nextAction: 'resume',
                },
                startedAt: 1_000,
                inputEpoch: 1,
                reportedTurns: 1,
                reportedTokens: 10,
                pausedFrom: 'repairing',
            },
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
        });

        const revision = restored.getStatus().revision;
        expect(restored.control('resume', revision)).toMatchObject({
            accepted: true, status: { stage: 'repairing' },
        });
    });
});
