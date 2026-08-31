import { describe, expect, it, vi } from 'vitest';
import type { AutonomousQualityGateStartRequestV1 } from '../api/autonomousQualityGateProtocol';
import { AutonomousQualityGateDaemonRegistry } from './autonomousQualityGateRegistry';

const request: AutonomousQualityGateStartRequestV1 = {
    schemaVersion: 1,
    requestId: 'candidate-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    directory: '/repo',
    recipeRevision: 'a'.repeat(64),
    plan: { phases: [{ name: 'test', command: 'npm test', timeoutMs: 1_000 }] },
    limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000, maxGateAttempts: 3 },
};

function memoryStore() {
    const runs = new Map<string, any>();
    const operations = new Set<string>();
    return {
        runs,
        hasOperation: (requestId: string) => operations.has(requestId),
        getBySessionId: (sessionId: string) => runs.get(sessionId),
        getByRunId: (runId: string) => [...runs.values()].find(run => run.status.runId === runId),
        put: vi.fn(async (requestId: string, run: any) => {
            if (operations.has(requestId)) return { applied: false, operationSeq: 1 };
            operations.add(requestId);
            runs.set(run.start.sessionId, { ...run, operationSeq: operations.size });
            return { applied: true, operationSeq: operations.size };
        }),
    };
}

describe('AutonomousQualityGateDaemonRegistry', () => {
    it('admits one gate for duplicate completion-candidate requests', async () => {
        const store = memoryStore();
        const runPhase = vi.fn(async () => ({
            name: 'test' as const,
            status: 'passed' as const,
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            stdoutTail: '',
            stderrTail: '',
            outputTruncated: false,
        }));
        const registry = new AutonomousQualityGateDaemonRegistry({
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-1',
            now: () => 1_000,
        });

        const [first, duplicate] = await Promise.all([registry.start(request), registry.start(request)]);

        expect(first).toMatchObject({ runId: 'run-1', stage: 'passed' });
        expect(duplicate).toEqual(first);
        expect(runPhase).toHaveBeenCalledOnce();
    });

    it('rehydrates daemon state and applies pause/status control without a renderer owner', async () => {
        const store = memoryStore();
        const first = new AutonomousQualityGateDaemonRegistry({
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase: vi.fn(async () => ({
                name: 'test' as const,
                status: 'failed' as const,
                exitCode: 1,
                timedOut: false,
                durationMs: 1,
                stdoutTail: '',
                stderrTail: 'failed',
                outputTruncated: false,
            })),
            sendRepair: vi.fn(async () => undefined),
            isSessionIdle: () => true,
            createRunId: () => 'run-restart',
            now: () => 1_000,
        });
        await first.start(request);

        const restarted = new AutonomousQualityGateDaemonRegistry({
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => false,
            createRunId: () => 'unused',
            now: () => 1_000,
        });
        const before = await restarted.status('session-1');
        const controlled = await restarted.control({
            schemaVersion: 1,
            requestId: 'pause-1',
            runId: 'run-restart',
            expectedRevision: before!.revision,
            action: 'pause',
        });

        expect(before).toMatchObject({ stage: 'repairing', attempt: 1 });
        expect(controlled).toMatchObject({ accepted: true, status: { stage: 'paused' } });
        await expect(restarted.status('session-1')).resolves.toMatchObject({ stage: 'paused' });
    });

    it('rejects a second-window candidate until the repair turn is observed busy then idle', async () => {
        const store = memoryStore();
        let fingerprint = 'before';
        const runPhase = vi.fn()
            .mockResolvedValueOnce({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            })
            .mockResolvedValueOnce({
                name: 'test', status: 'passed', exitCode: 0, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: '', outputTruncated: false,
            });
        const registry = new AutonomousQualityGateDaemonRegistry({
            store,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(async () => undefined),
            isSessionIdle: () => true,
            createRunId: () => 'run-one-owner',
            now: () => 1_000,
        });
        await registry.start(request);
        await expect(registry.start({ ...request, requestId: 'window-2' }))
            .resolves.toMatchObject({ stage: 'repairing' });
        expect(runPhase).toHaveBeenCalledOnce();

        registry.noteSessionRuntime('session-1', { idle: false, userInput: true });
        registry.noteSessionRuntime('session-1', { idle: true, userInput: false });
        fingerprint = 'changed';
        await expect(registry.start({ ...request, requestId: 'candidate-after-repair' }))
            .resolves.toMatchObject({ stage: 'passed' });
        expect(runPhase).toHaveBeenCalledTimes(2);
    });
});
