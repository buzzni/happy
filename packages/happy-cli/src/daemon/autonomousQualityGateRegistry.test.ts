import { describe, expect, it, vi } from 'vitest';
import type { AutonomousQualityGateStartRequestV1 } from '../api/autonomousQualityGateProtocol';
import { AutonomousQualityGateDaemonRegistry } from './autonomousQualityGateRegistry';
import { MAX_START_OPERATION_KEYS } from './autonomousQualityGateStore';

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

const matchingSessionDirectory = {
    resolveSessionDirectory: async (_sessionId: string, directory: string) => directory,
};

function memoryStore() {
    const runs = new Map<string, any>();
    const operations = new Set<string>();
    const operationResults = new Map<string, any>();
    return {
        runs,
        hasOperation: (requestId: string) => operations.has(requestId),
        getOperationResult: (requestId: string) => operationResults.get(requestId),
        getBySessionId: (sessionId: string) => runs.get(sessionId),
        getByRunId: (runId: string) => [...runs.values()].find(run => run.status.runId === runId),
        getActiveByDirectory: (directory: string, exceptSessionId: string) => [...runs.values()].find(run => (
            run.start.directory === directory
            && run.start.sessionId !== exceptSessionId
            && !['passed', 'stopped', 'blocked', 'limit-reached'].includes(run.status.stage)
        )),
        put: vi.fn(async (requestId: string, run: any, result?: any) => {
            if (operations.has(requestId)) return { applied: false, operationSeq: 1 };
            operations.add(requestId);
            if (result) operationResults.set(requestId, result);
            runs.set(run.start.sessionId, { ...run, operationSeq: operations.size });
            return { applied: true, operationSeq: operations.size };
        }),
        update: vi.fn(async (run: any) => {
            const current = runs.get(run.start.sessionId);
            if (!current) throw new Error('run not found');
            runs.set(run.start.sessionId, { ...run, operationSeq: current.operationSeq });
            return { operationSeq: current.operationSeq };
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
            ...matchingSessionDirectory,
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

    it('re-admits an exact waiting start after the daemon observes the session idle', async () => {
        const store = memoryStore();
        let idle = false;
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => idle,
            createRunId: () => 'run-waiting-for-idle',
        });

        await expect(registry.start(request)).resolves.toMatchObject({
            runId: 'run-waiting-for-idle', stage: 'awaiting-completion',
        });
        expect(runPhase).not.toHaveBeenCalled();

        idle = true;
        await expect(registry.start(request)).resolves.toMatchObject({
            runId: 'run-waiting-for-idle', stage: 'passed',
        });
        expect(runPhase).toHaveBeenCalledOnce();
    });

    it('revalidates session directory ownership before re-admitting an exact waiting start', async () => {
        const store = memoryStore();
        let idle = false;
        let directoryOwned = true;
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        const registry = new AutonomousQualityGateDaemonRegistry({
            store,
            resolveSessionDirectory: async (_sessionId, directory) => directoryOwned ? directory : null,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => idle,
            createRunId: () => 'run-directory-revalidation',
        });
        await expect(registry.start(request)).resolves.toMatchObject({ stage: 'awaiting-completion' });

        directoryOwned = false;
        idle = true;
        await expect(registry.start(request)).rejects.toThrow('session directory mismatch');
        expect(runPhase).not.toHaveBeenCalled();
    });

    it('does not re-admit an exact start whose gate result was discarded as stale', async () => {
        const store = memoryStore();
        const capture = vi.fn()
            .mockResolvedValueOnce({ digest: 'before', entryCount: 1, excludedCount: 0 })
            .mockResolvedValueOnce({ digest: 'after', entryCount: 1, excludedCount: 0 });
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture,
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-stale-candidate',
        });

        await expect(registry.start(request)).resolves.toMatchObject({
            stage: 'awaiting-completion', fingerprintChanged: true,
        });
        await expect(registry.start(request)).resolves.toMatchObject({
            stage: 'awaiting-completion', fingerprintChanged: true,
        });

        expect(runPhase).toHaveBeenCalledOnce();
        expect(capture).toHaveBeenCalledTimes(2);
    });

    it('coalesces different request ids for the same in-flight session candidate', async () => {
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
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-multi-window',
        });

        const [first, second] = await Promise.all([
            registry.start(request),
            registry.start({ ...request, requestId: 'other-window-candidate' }),
        ]);

        expect(first).toMatchObject({ runId: 'run-multi-window', stage: 'passed' });
        expect(second).toEqual(first);
        expect(runPhase).toHaveBeenCalledOnce();
        const resolveSessionDirectory = vi.fn(async () => null);
        const restarted = new AutonomousQualityGateDaemonRegistry({
            resolveSessionDirectory,
            store: { ...store, hasOperation: () => false },
            capture: vi.fn(),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
        });

        await expect(restarted.start({ ...request, requestId: 'other-window-candidate' }))
            .resolves.toEqual(second);
        expect(resolveSessionDirectory).not.toHaveBeenCalled();
        expect(runPhase).toHaveBeenCalledOnce();
    });

    it('replays an exact persisted start after its bounded operation journal entry is evicted', async () => {
        const store = memoryStore();
        const firstRunPhase = vi.fn(async () => ({
            name: 'test' as const,
            status: 'passed' as const,
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            stdoutTail: '',
            stderrTail: '',
            outputTruncated: false,
        }));
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase: firstRunPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-before-journal-eviction',
        });
        const passed = await first.start(request);
        const restartedRunPhase = vi.fn(firstRunPhase.getMockImplementation()!);
        const resolveSessionDirectory = vi.fn(async () => null);
        const restarted = new AutonomousQualityGateDaemonRegistry({
            resolveSessionDirectory,
            store: { ...store, hasOperation: () => false },
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase: restartedRunPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-after-journal-eviction',
        });

        await expect(restarted.start(request)).resolves.toEqual(passed);
        expect(resolveSessionDirectory).not.toHaveBeenCalled();
        expect(restartedRunPhase).not.toHaveBeenCalled();
    });

    it('does not alias the same client request id across sessions', async () => {
        const store = memoryStore();
        let runNumber = 0;
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
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });

        const [first, second] = await Promise.all([
            registry.start(request),
            registry.start({
                ...request,
                sessionId: 'session-2',
                projectId: 'project-2',
                directory: '/repo-2',
            }),
        ]);

        expect(first).toMatchObject({ sessionId: 'session-1', runId: 'run-1', stage: 'passed' });
        expect(second).toMatchObject({ sessionId: 'session-2', runId: 'run-2', stage: 'passed' });
        expect(runPhase).toHaveBeenCalledTimes(2);
    });

    it('starts a fresh run for a new request after the previous run passed', async () => {
        const store = memoryStore();
        let runNumber = 0;
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
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });

        await expect(registry.start(request)).resolves.toMatchObject({ runId: 'run-1', stage: 'passed' });
        await expect(registry.start({ ...request, requestId: 'candidate-2' }))
            .resolves.toMatchObject({ runId: 'run-2', stage: 'passed' });
        expect(runPhase).toHaveBeenCalledTimes(2);
    });

    it('drops terminal runtime entries evicted by the bounded store', async () => {
        const store = memoryStore();
        const originalPut = store.put.getMockImplementation()!;
        store.put.mockImplementation(async (...args: Parameters<typeof originalPut>) => {
            const result = await originalPut(...args);
            if (args[1].start.sessionId === 'session-2') store.runs.delete(request.sessionId);
            return result;
        });
        let runNumber = 0;
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase: vi.fn(async () => ({
                name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
                durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
            })),
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });
        await registry.start(request);
        await registry.start({
            ...request,
            requestId: 'candidate-session-2',
            sessionId: 'session-2',
            projectId: 'project-2',
            directory: '/repo-2',
        });

        await expect(registry.status(request.sessionId)).resolves.toBeNull();
    });

    it('rejects a delayed start from a run replaced by a newer completion candidate', async () => {
        const store = memoryStore();
        let runNumber = 0;
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
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });

        await registry.start(request);
        await registry.start({ ...request, requestId: 'candidate-2' });
        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });

        await expect(restarted.start(request))
            .rejects.toThrow('autonomous quality gate start request is stale');
        expect(runPhase).toHaveBeenCalledTimes(2);
    });

    it('does not replay a passed start when the same request id carries a different candidate', async () => {
        const store = memoryStore();
        let runNumber = 0;
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
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });

        await expect(registry.start(request)).resolves.toMatchObject({ runId: 'run-1' });
        await expect(registry.start({ ...request, recipeRevision: 'b'.repeat(64) }))
            .resolves.toMatchObject({ runId: 'run-2' });
        expect(runPhase).toHaveBeenCalledTimes(2);
    });

    it('returns the live terminal result when final snapshot persistence failed', async () => {
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
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-final-write-failure',
        });
        store.update.mockRejectedValueOnce(new Error('disk full'));

        await expect(registry.start(request)).rejects.toThrow('disk full');
        await expect(registry.start(request)).resolves.toMatchObject({
            runId: 'run-final-write-failure',
            stage: 'passed',
        });
        expect(runPhase).toHaveBeenCalledOnce();
        expect(store.runs.get('session-1')).toMatchObject({
            status: { runId: 'run-final-write-failure', stage: 'passed' },
        });
    });

    it('retries a bounded alias reservation failure without suppressing the gate', async () => {
        const store = memoryStore();
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        let putCount = 0;
        const originalPut = store.put.getMockImplementation()!;
        store.put.mockImplementation(async (...args: Parameters<typeof originalPut>) => {
            putCount += 1;
            if (putCount === MAX_START_OPERATION_KEYS + 1) throw new Error('disk full');
            return originalPut(...args);
        });
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-many-aliases',
        });
        const starts = Array.from({ length: MAX_START_OPERATION_KEYS + 1 }, (_, index) => registry.start({
            ...request,
            requestId: `candidate-${index}`,
        }));
        const results = await Promise.allSettled(starts);
        expect(results.every(result => result.status === 'fulfilled')).toBe(true);

        await expect(registry.start({ ...request, requestId: 'candidate-1' }))
            .resolves.toMatchObject({ runId: 'run-many-aliases', stage: 'passed' });
        expect(runPhase).toHaveBeenCalledOnce();
    });

    it('replays every coalesced start alias still retained by the operation journal', async () => {
        const store = memoryStore();
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-journal-aliases',
        });
        const starts = Array.from({ length: MAX_START_OPERATION_KEYS + 1 }, (_, index) => registry.start({
            ...request,
            requestId: `candidate-${index}`,
        }));

        await Promise.all(starts);

        await expect(registry.start({ ...request, requestId: 'candidate-1' }))
            .resolves.toMatchObject({ runId: 'run-journal-aliases', stage: 'passed' });
        expect(runPhase).toHaveBeenCalledOnce();
    });

    it('fails closed when an exact start request is replayed after a verifying daemon restart', async () => {
        const store = memoryStore();
        const passedPhase = {
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        };
        let finishPhase!: () => void;
        const phaseResult = new Promise<typeof passedPhase>(resolve => {
            finishPhase = () => resolve(passedPhase);
        });
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase: () => phaseResult,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-interrupted',
        });
        const interruptedStart = first.start(request);
        await vi.waitFor(() => expect(store.runs.get('session-1')).toMatchObject({
            status: { stage: 'verifying' },
        }));

        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
        });

        await expect(restarted.start(request)).resolves.toMatchObject({
            runId: 'run-interrupted',
            stage: 'blocked',
            blockedReason: 'interrupted-operation',
        });

        finishPhase();
        await interruptedStart;
    });

    it('persists an in-flight alias before restart recovery can repeat the gate', async () => {
        const store = memoryStore();
        const passedPhase = {
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        };
        let finishPhase!: () => void;
        const phaseResult = new Promise<typeof passedPhase>(resolve => {
            finishPhase = () => resolve(passedPhase);
        });
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase: () => phaseResult,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-interrupted-alias',
        });
        const interruptedStart = first.start(request);
        await vi.waitFor(() => expect(store.runs.get('session-1')).toMatchObject({
            status: { stage: 'verifying' },
        }));
        const aliasRequest = { ...request, requestId: 'other-window-in-flight' };
        const interruptedAlias = first.start(aliasRequest);
        await vi.waitFor(() => expect(store.runs.get('session-1')?.startOperationKeys).toHaveLength(2));
        const restartedRunPhase = vi.fn(async () => passedPhase);
        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: restartedRunPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-duplicate-after-restart',
        });

        await expect(restarted.start(aliasRequest)).resolves.toMatchObject({
            runId: 'run-interrupted-alias',
            stage: 'blocked',
            blockedReason: 'interrupted-operation',
        });
        expect(restartedRunPhase).not.toHaveBeenCalled();

        finishPhase();
        await Promise.all([interruptedStart, interruptedAlias]);
    });

    it('releases an interrupted verifying worktree before admitting a new session after restart', async () => {
        const store = memoryStore();
        store.runs.set('session-1', {
            start: request,
            startOperationKeys: [],
            status: {
                schemaVersion: 1,
                runId: 'run-interrupted-writer',
                revision: 3,
                sessionId: 'session-1',
                projectId: 'project-1',
                stage: 'verifying',
                attempt: 0,
                usage: { continuations: 0, turns: 0, tokens: 0, elapsedMs: 10 },
                limits: request.limits,
                fingerprintChanged: null,
                nextAction: 'wait',
            },
            startedAt: 1_000,
            inputEpoch: 0,
            operationSeq: 1,
        });
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false,
            durationMs: 1, stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'clean', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-new-writer',
        });

        await expect(restarted.start({
            ...request,
            requestId: 'candidate-new-session',
            sessionId: 'session-2',
        })).resolves.toMatchObject({ runId: 'run-new-writer', stage: 'passed' });

        expect(runPhase).toHaveBeenCalledOnce();
        expect(store.runs.get('session-1')).toMatchObject({
            status: { stage: 'blocked', blockedReason: 'interrupted-operation' },
        });
    });

    it('rehydrates daemon state and applies pause/status control without a renderer owner', async () => {
        const store = memoryStore();
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
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
            ...matchingSessionDirectory,
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

    it('expires an idle persisted run when status observes the total timeout', async () => {
        const store = memoryStore();
        let now = 1_000;
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => false,
            createRunId: () => 'run-idle-timeout',
            now: () => now,
        });
        await expect(registry.start({
            ...request,
            limits: { ...request.limits, timeoutMs: 1_000 },
        })).resolves.toMatchObject({ stage: 'awaiting-completion' });

        now = 2_001;

        await expect(registry.status('session-1')).resolves.toMatchObject({
            stage: 'limit-reached',
            limitReason: 'timeout',
            nextAction: 'none',
            usage: { elapsedMs: 1_001 },
        });
        expect(store.update).toHaveBeenCalled();
        expect(store.runs.get('session-1')).toMatchObject({
            status: { stage: 'limit-reached', limitReason: 'timeout' },
        });
    });

    it('re-admits an exact second-window start after the repair turn is observed busy then idle', async () => {
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
            ...matchingSessionDirectory,
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
        await expect(registry.start({ ...request, requestId: 'window-2' }))
            .resolves.toMatchObject({ stage: 'passed' });
        expect(runPhase).toHaveBeenCalledTimes(2);
    });

    it('preserves a repair turn completed while delivery is paused', async () => {
        const store = memoryStore();
        let fingerprint = 'before';
        let sessionRuntime = { idle: true, lastTurnEndAt: 100 };
        let repairStarted!: () => void;
        let finishRepair!: () => void;
        const started = new Promise<void>(resolve => { repairStarted = resolve; });
        const pendingRepair = new Promise<void>(resolve => { finishRepair = resolve; });
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
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase,
            sendRepair: async () => {
                repairStarted();
                await pendingRepair;
            },
            getSessionRuntime: () => sessionRuntime,
            createRunId: () => 'run-paused-repair-delivery',
            now: () => 1_000,
        });

        const completion = registry.start(request);
        await started;
        const verifying = await registry.status(request.sessionId);
        await registry.control({
            schemaVersion: 1,
            requestId: 'pause-repair-delivery',
            runId: verifying!.runId,
            expectedRevision: verifying!.revision,
            action: 'pause',
        });
        expect(store.runs.get(request.sessionId)).toMatchObject({
            pausedFrom: 'repairing',
            repairBaselineLastTurnEndAt: 100,
        });
        sessionRuntime = { idle: false, lastTurnEndAt: 100 };
        registry.noteSessionRuntime(request.sessionId, { ...sessionRuntime, userInput: false });
        sessionRuntime = { idle: true, lastTurnEndAt: 200 };
        registry.noteSessionRuntime(request.sessionId, { ...sessionRuntime, userInput: false });
        finishRepair();

        const paused = await completion;
        expect(paused).toMatchObject({ stage: 'paused', usage: { continuations: 1 } });
        await expect(registry.control({
            schemaVersion: 1,
            requestId: 'resume-repair-delivery',
            runId: paused.runId,
            expectedRevision: paused.revision,
            action: 'resume',
        })).resolves.toMatchObject({ accepted: true, status: { stage: 'repairing' } });

        fingerprint = 'changed';
        await expect(registry.start({ ...request, requestId: 'after-paused-repair' }))
            .resolves.toMatchObject({ stage: 'passed' });
        expect(runPhase).toHaveBeenCalledTimes(2);
    });

    it('repairs private pause state after a failed delivery snapshot write', async () => {
        const store = memoryStore();
        let repairStarted!: () => void;
        let failRepair!: () => void;
        const started = new Promise<void>(resolve => { repairStarted = resolve; });
        const pendingRepair = new Promise<void>((_resolve, reject) => {
            failRepair = () => reject(new Error('session unavailable'));
        });
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 1, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            }),
            sendRepair: async () => {
                repairStarted();
                await pendingRepair;
            },
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt: 100 }),
            createRunId: () => 'run-failed-repair-snapshot',
            now: () => 1_000,
        });

        const completion = registry.start(request);
        await started;
        const verifying = await registry.status(request.sessionId);
        await registry.control({
            schemaVersion: 1,
            requestId: 'pause-before-failed-delivery',
            runId: verifying!.runId,
            expectedRevision: verifying!.revision,
            action: 'pause',
        });
        store.update.mockRejectedValueOnce(new Error('disk full'));
        failRepair();
        await expect(completion).rejects.toThrow('disk full');
        expect(store.runs.get(request.sessionId)).toMatchObject({ pausedFrom: 'repairing' });

        const replayed = await registry.start(request);
        expect(replayed).toMatchObject({ stage: 'paused' });
        expect(store.runs.get(request.sessionId)).toMatchObject({ pausedFrom: 'awaiting-completion' });
        await expect(registry.control({
            schemaVersion: 1,
            requestId: 'resume-after-failed-delivery',
            runId: replayed.runId,
            expectedRevision: replayed.revision,
            action: 'resume',
        })).resolves.toMatchObject({ accepted: true, status: { stage: 'awaiting-completion' } });
    });

    it('persists restored redaction before replaying an exact repair status', async () => {
        const store = memoryStore();
        const failedPhase = {
            name: 'test' as const, status: 'failed' as const, exitCode: 1, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
        };
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 1, excludedCount: 0 }),
            runPhase: async () => failedPhase,
            sendRepair: vi.fn(async () => undefined),
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt: 100 }),
            createRunId: () => 'run-restored-redaction',
            now: () => 1_000,
        });
        await first.start(request);
        store.runs.get(request.sessionId).previousFailure.result.stdoutTail = 'TOKEN=hidden';

        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt: 100 }),
            now: () => 2_000,
        });
        await expect(restarted.start(request)).resolves.toMatchObject({ stage: 'repairing' });

        expect(JSON.stringify(store.runs.get(request.sessionId).previousFailure)).not.toContain('hidden');
    });

    it('persists restored redaction before returning hydrated status', async () => {
        const store = memoryStore();
        const failedPhase = {
            name: 'test' as const, status: 'failed' as const, exitCode: 1, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
        };
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 1, excludedCount: 0 }),
            runPhase: async () => failedPhase,
            sendRepair: vi.fn(async () => undefined),
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt: 100 }),
            createRunId: () => 'run-status-redaction',
            now: () => 1_000,
        });
        await first.start(request);
        store.runs.get(request.sessionId).previousFailure.result.stderrTail = 'PASSWORD=hidden';

        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt: 100 }),
            now: () => 2_000,
        });
        await expect(restarted.status(request.sessionId)).resolves.toMatchObject({ stage: 'repairing' });

        expect(JSON.stringify(store.runs.get(request.sessionId).previousFailure)).not.toContain('hidden');
    });

    it('returns control state that changed while hydrated redaction was persisted', async () => {
        const store = memoryStore();
        const failedPhase = {
            name: 'test' as const, status: 'failed' as const, exitCode: 1, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
        };
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 1, excludedCount: 0 }),
            runPhase: async () => failedPhase,
            sendRepair: vi.fn(async () => undefined),
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt: 100 }),
            createRunId: () => 'run-status-race',
            now: () => 1_000,
        });
        const repairing = await first.start(request);
        store.runs.get(request.sessionId).previousFailure.result.stderrTail = 'PASSWORD=hidden';
        let releaseRedactionWrite!: () => void;
        const redactionWrite = new Promise<void>(resolve => { releaseRedactionWrite = resolve; });
        const originalUpdate = store.update.getMockImplementation()!;
        store.update.mockImplementationOnce(async (...args: Parameters<typeof originalUpdate>) => {
            await redactionWrite;
            return originalUpdate(...args);
        });

        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt: 100 }),
            now: () => 2_000,
        });
        const hydration = restarted.status(request.sessionId);
        await vi.waitFor(() => expect(store.update).toHaveBeenCalled());
        const pause = restarted.control({
            schemaVersion: 1,
            requestId: 'pause-during-status-redaction',
            runId: repairing.runId,
            expectedRevision: repairing.revision,
            action: 'pause',
        });
        releaseRedactionWrite();

        await expect(pause).resolves.toMatchObject({ accepted: true, status: { stage: 'paused' } });
        await expect(hydration).resolves.toMatchObject({ stage: 'paused' });
    });

    it('restores the repair turn boundary after daemon restart', async () => {
        const store = memoryStore();
        let lastTurnEndAt = 100;
        let fingerprint = 'before';
        const failedPhase = {
            name: 'test' as const, status: 'failed' as const, exitCode: 1, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
        };
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase: async () => failedPhase,
            sendRepair: vi.fn(async () => undefined),
            getSessionRuntime: () => ({ idle: true, turns: 5, tokens: 500, lastTurnEndAt }),
            createRunId: () => 'run-repair-restart',
            now: () => 1_000,
        });
        await first.start(request);

        lastTurnEndAt = 200;
        fingerprint = 'changed';
        const restartedRunPhase = vi.fn(async () => ({
            ...failedPhase, status: 'passed' as const, exitCode: 0, stderrTail: '',
        }));
        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase: restartedRunPhase,
            sendRepair: vi.fn(),
            getSessionRuntime: () => ({ idle: true, turns: 6, tokens: 700, lastTurnEndAt }),
            now: () => 2_000,
        });

        await expect(restarted.start({ ...request, requestId: 'after-restart' })).resolves.toMatchObject({
            stage: 'passed',
            usage: { turns: 1, tokens: 200 },
        });
        expect(restartedRunPhase).toHaveBeenCalledOnce();
    });

    it('preserves restored usage baselines until the restarted daemon receives a runtime report', async () => {
        const store = memoryStore();
        let lastTurnEndAt = 100;
        let fingerprint = 'before';
        const failedPhase = {
            name: 'test' as const, status: 'failed' as const, exitCode: 1, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
        };
        const first = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase: async () => failedPhase,
            sendRepair: vi.fn(async () => undefined),
            getSessionRuntime: () => ({ idle: true, turns: 5, tokens: 500, lastTurnEndAt }),
            createRunId: () => 'run-usage-restart',
            now: () => 1_000,
        });
        await first.start(request);

        lastTurnEndAt = 200;
        fingerprint = 'after-edit';
        const restarted = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: fingerprint, entryCount: 1, excludedCount: 0 }),
            runPhase: async () => failedPhase,
            sendRepair: vi.fn(async () => undefined),
            getSessionRuntime: () => ({ idle: true, lastTurnEndAt }),
            now: () => 2_000,
        });
        await restarted.start({ ...request, requestId: 'after-restart-without-report' });

        restarted.noteSessionRuntime('session-1', {
            idle: true,
            userInput: false,
            turns: 6,
            tokens: 700,
            lastTurnEndAt: 300,
        });

        await expect(restarted.status('session-1')).resolves.toMatchObject({
            usage: { turns: 1, tokens: 200 },
        });
    });

    it('blocks a second active writer for the same worktree', async () => {
        const store = memoryStore();
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'failed' as const, exitCode: 1, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
        }));
        let runNumber = 0;
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 1, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(async () => undefined),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
            now: () => 1_000,
        });
        await registry.start(request);

        await expect(registry.start({
            ...request,
            requestId: 'second-session',
            sessionId: 'session-2',
        })).resolves.toMatchObject({
            sessionId: 'session-2',
            stage: 'blocked',
            blockedReason: 'worktree-in-use',
        });
        expect(runPhase).toHaveBeenCalledOnce();
    });

    it('replays the original rejected control result for a duplicate request', async () => {
        const store = memoryStore();
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'passed', exitCode: 0, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: '', outputTruncated: false,
            }),
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-control-dedupe',
        });
        await registry.start(request);
        await registry.control({
            schemaVersion: 1, requestId: 'pause-terminal', runId: 'run-control-dedupe',
            expectedRevision: 0, action: 'pause',
        });

        const duplicate = await registry.control({
            schemaVersion: 1, requestId: 'pause-terminal', runId: 'run-control-dedupe',
            expectedRevision: 0, action: 'pause',
        });

        expect(duplicate).toMatchObject({ accepted: false, duplicate: true, status: { stage: 'passed' } });
    });

    it('coalesces concurrent duplicate resume controls before either result reaches the journal', async () => {
        const store = memoryStore();
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => false,
            createRunId: () => 'run-concurrent-control',
        });
        const started = await registry.start(request);
        const paused = await registry.control({
            schemaVersion: 1,
            requestId: 'pause-before-concurrent-resume',
            runId: started.runId,
            expectedRevision: started.revision,
            action: 'pause',
        }) as { status: { revision: number } };
        const basePut = store.put.getMockImplementation()!;
        let resumeWriteStarted!: () => void;
        let releaseResumeWrite!: () => void;
        const writeStarted = new Promise<void>(resolve => { resumeWriteStarted = resolve; });
        const writeReleased = new Promise<void>(resolve => { releaseResumeWrite = resolve; });
        store.put.mockImplementation(async (requestId: string, run: any, result?: any) => {
            if (result?.accepted && result.status.stage === 'awaiting-completion') {
                resumeWriteStarted();
                await writeReleased;
            }
            return basePut(requestId, run, result);
        });
        const resume = {
            schemaVersion: 1 as const,
            requestId: 'concurrent-resume',
            runId: started.runId,
            expectedRevision: paused.status.revision,
            action: 'resume' as const,
        };

        const first = registry.control(resume);
        await writeStarted;
        const duplicate = registry.control(resume);
        releaseResumeWrite();

        await expect(first).resolves.toMatchObject({ accepted: true, status: { stage: 'awaiting-completion' } });
        await expect(duplicate).resolves.toMatchObject({
            accepted: true,
            duplicate: true,
            status: { stage: 'awaiting-completion' },
        });
        await expect(registry.control(resume)).resolves.toMatchObject({
            accepted: true,
            duplicate: true,
            status: { stage: 'awaiting-completion' },
        });
    });

    it('does not alias the same control request id across runs', async () => {
        const store = memoryStore();
        let runNumber = 0;
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: async () => ({
                name: 'test', status: 'failed', exitCode: 1, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: 'failed', outputTruncated: false,
            }),
            sendRepair: vi.fn(async () => undefined),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });
        const first = await registry.start(request);
        const second = await registry.start({
            ...request,
            requestId: 'candidate-2',
            sessionId: 'session-2',
            projectId: 'project-2',
            directory: '/repo-2',
        });

        await registry.control({
            schemaVersion: 1, requestId: 'same-control', runId: first.runId,
            expectedRevision: first.revision, action: 'pause',
        });
        const secondControl = await registry.control({
            schemaVersion: 1, requestId: 'same-control', runId: second.runId,
            expectedRevision: second.revision, action: 'pause',
        });

        expect(secondControl).toMatchObject({ accepted: true, status: { runId: second.runId, stage: 'paused' } });
    });

    it('does not replay a pause when the same control request id is reused for stop', async () => {
        const store = memoryStore();
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => false,
            createRunId: () => 'run-control-payload',
        });
        const started = await registry.start(request);
        await registry.control({
            schemaVersion: 1, requestId: 'reused-control', runId: started.runId,
            expectedRevision: started.revision, action: 'pause',
        });

        await expect(registry.control({
            schemaVersion: 1, requestId: 'reused-control', runId: started.runId,
            expectedRevision: started.revision, action: 'stop',
        })).resolves.toMatchObject({ accepted: true, status: { stage: 'stopped' } });
    });

    it('fails closed in paused state when persisting resume fails', async () => {
        const store = memoryStore();
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => false,
            createRunId: () => 'run-resume-write-failure',
        });
        const started = await registry.start(request);
        const paused = await registry.control({
            schemaVersion: 1,
            requestId: 'pause-before-write-failure',
            runId: started.runId,
            expectedRevision: started.revision,
            action: 'pause',
        }) as { status: { revision: number } };
        store.put.mockRejectedValueOnce(new Error('disk full'));

        await expect(registry.control({
            schemaVersion: 1,
            requestId: 'resume-write-failure',
            runId: started.runId,
            expectedRevision: paused.status.revision,
            action: 'resume',
        })).rejects.toThrow('disk full');

        await expect(registry.status(request.sessionId)).resolves.toMatchObject({
            stage: 'paused',
            nextAction: 'resume',
        });
    });

    it('stops and persists a run when its session process exits', async () => {
        const store = memoryStore();
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => false,
            createRunId: () => 'run-session-exit',
        });
        await registry.start(request);

        registry.noteSessionStopped('session-1');

        await expect(registry.status('session-1')).resolves.toMatchObject({ stage: 'stopped' });
        await vi.waitFor(() => expect(store.runs.get('session-1')).toMatchObject({ status: { stage: 'stopped' } }));
    });

    it('isolates an unavailable gate store from ordinary session runtime and stop notifications', () => {
        const store = memoryStore();
        const unavailable = new Error('autonomous quality gate store is unavailable');
        const getBySessionId = vi.fn(() => { throw unavailable; });
        store.getBySessionId = getBySessionId;
        const onPersistenceError = vi.fn(() => { throw new Error('diagnostics failed'); });
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            onPersistenceError,
        });

        expect(() => registry.noteSessionRuntime('ordinary-session', {
            idle: true,
            userInput: false,
        })).not.toThrow();
        expect(() => registry.noteSessionStopped('ordinary-session')).not.toThrow();
        expect(getBySessionId).toHaveBeenCalledTimes(2);
        expect(onPersistenceError).toHaveBeenCalledOnce();
        expect(onPersistenceError).toHaveBeenCalledWith(unavailable);
    });

    it('reports one notification write failure until persistence recovers', async () => {
        const store = memoryStore();
        const onPersistenceError = vi.fn();
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: vi.fn(),
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            isSessionIdle: () => false,
            onPersistenceError,
        });
        await registry.start(request);
        const diskFull = new Error('disk full');
        store.update.mockRejectedValue(diskFull);

        registry.noteSessionRuntime('session-1', { idle: false, userInput: true });
        registry.noteSessionRuntime('session-1', { idle: false, userInput: true });
        await vi.waitFor(() => expect(onPersistenceError).toHaveBeenCalledOnce());

        store.update.mockResolvedValue({ operationSeq: 1 });
        registry.noteSessionRuntime('session-1', { idle: false, userInput: true });
        await vi.waitFor(() => expect(store.update).toHaveBeenCalledTimes(4));
        await Promise.resolve();

        store.update.mockRejectedValue(diskFull);
        registry.noteSessionRuntime('session-1', { idle: false, userInput: true });
        await vi.waitFor(() => expect(onPersistenceError).toHaveBeenCalledTimes(2));
    });

    it('rejects a gate directory that does not belong to the target session', async () => {
        const store = memoryStore();
        const capture = vi.fn();
        const registry = new AutonomousQualityGateDaemonRegistry({
            store,
            capture,
            runPhase: vi.fn(),
            sendRepair: vi.fn(),
            resolveSessionDirectory: async () => null,
            isSessionIdle: () => true,
        });

        await expect(registry.start(request)).rejects.toThrow('session directory mismatch');
        expect(capture).not.toHaveBeenCalled();
        expect(store.runs.size).toBe(0);
    });

    it('blocks an in-flight second writer before the first run reaches disk', async () => {
        const store = memoryStore();
        let releaseFirstPersist!: () => void;
        const firstPersist = new Promise<void>(resolve => { releaseFirstPersist = resolve; });
        const originalPut = store.put.getMockImplementation()!;
        store.put.mockImplementationOnce(async (...args: Parameters<typeof originalPut>) => {
            await firstPersist;
            return originalPut(...args);
        });
        let runNumber = 0;
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase: vi.fn(async () => ({
                name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false, durationMs: 1,
                stdoutTail: '', stderrTail: '', outputTruncated: false,
            })),
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });

        const first = registry.start(request);
        await vi.waitFor(() => expect(store.put).toHaveBeenCalledOnce());
        const second = registry.start({
            ...request,
            requestId: 'concurrent-session',
            sessionId: 'session-2',
        });

        await expect(second).resolves.toMatchObject({
            sessionId: 'session-2', stage: 'blocked', blockedReason: 'worktree-in-use',
        });
        releaseFirstPersist();
        await expect(first).resolves.toMatchObject({ sessionId: 'session-1', stage: 'passed' });
    });

    it('releases a newly-created writer when its initial persistence fails', async () => {
        const store = memoryStore();
        store.put.mockRejectedValueOnce(new Error('disk full'));
        let runNumber = 0;
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => `run-${++runNumber}`,
        });

        const first = registry.start(request);
        const alias = registry.start({ ...request, requestId: 'failed-write-alias' });
        await expect(first).rejects.toThrow('disk full');
        await expect(alias).rejects.toThrow('disk full');
        expect(store.runs.size).toBe(0);
        await expect(registry.start({
            ...request,
            requestId: 'second-after-failed-write',
            sessionId: 'session-2',
            projectId: 'project-2',
        })).resolves.toMatchObject({ sessionId: 'session-2', stage: 'passed' });
        expect(runPhase).toHaveBeenCalledOnce();
    });

    it('admits a queued newer candidate after the active candidate fails to persist', async () => {
        const store = memoryStore();
        store.put.mockRejectedValueOnce(new Error('disk full'));
        const runPhase = vi.fn(async () => ({
            name: 'test' as const, status: 'passed' as const, exitCode: 0, timedOut: false, durationMs: 1,
            stdoutTail: '', stderrTail: '', outputTruncated: false,
        }));
        const registry = new AutonomousQualityGateDaemonRegistry({
            ...matchingSessionDirectory,
            store,
            capture: async () => ({ digest: 'same', entryCount: 0, excludedCount: 0 }),
            runPhase,
            sendRepair: vi.fn(),
            isSessionIdle: () => true,
            createRunId: () => 'run-after-queued-failure',
        });

        const first = registry.start(request);
        const newer = registry.start({
            ...request,
            requestId: 'newer-candidate',
            recipeRevision: 'b'.repeat(64),
        });

        await expect(first).rejects.toThrow('disk full');
        await expect(newer).resolves.toMatchObject({ stage: 'passed' });
        expect(runPhase).toHaveBeenCalledOnce();
    });
});
