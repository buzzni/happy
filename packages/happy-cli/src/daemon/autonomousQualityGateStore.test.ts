import { describe, expect, it, vi } from 'vitest';
import type {
    AutonomousQualityGateStartRequestV1,
    AutonomousQualityGateStatusV1,
} from '../api/autonomousQualityGateProtocol';
import { AutonomousQualityGateRunStore } from './autonomousQualityGateStore';

const start: AutonomousQualityGateStartRequestV1 = {
    schemaVersion: 1,
    requestId: 'start-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    directory: '/repo',
    recipeRevision: 'a'.repeat(64),
    plan: { phases: [{ name: 'test', command: 'npm test', timeoutMs: 1_000 }] },
    limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000, maxGateAttempts: 3 },
};

const status: AutonomousQualityGateStatusV1 = {
    schemaVersion: 1,
    runId: 'run-1',
    revision: 0,
    sessionId: 'session-1',
    projectId: 'project-1',
    stage: 'awaiting-completion',
    attempt: 0,
    usage: { continuations: 0, turns: 0, tokens: 0, elapsedMs: 0 },
    limits: start.limits,
    fingerprintChanged: null,
    nextAction: 'wait',
};

function memoryFile() {
    const files = new Map<string, string>();
    const renames: Array<[string, string]> = [];
    return {
        files,
        renames,
        deps: {
            readFile: async (path: string) => {
                const value = files.get(path);
                if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                return value;
            },
            writeFile: async (path: string, value: string) => { files.set(path, value); },
            rename: async (from: string, to: string) => {
                renames.push([from, to]);
                files.set(to, files.get(from)!);
                files.delete(from);
            },
            mkdir: async () => {},
        },
    };
}

describe('AutonomousQualityGateRunStore', () => {
    it('isolates an unreadable additive store without preventing daemon startup', async () => {
        const memory = memoryFile();
        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', {
            ...memory.deps,
            readFile: async () => {
                throw Object.assign(new Error('permission details must stay internal'), { code: 'EACCES' });
            },
        });

        expect(() => store.getBySessionId('session-1'))
            .toThrow('autonomous quality gate store is unavailable');
        await expect(store.put('operation-1', { start, status, startedAt: 100, inputEpoch: 0 }))
            .rejects.toThrow('autonomous quality gate store is unavailable');
    });

    it('keeps a malformed additive store unavailable without mutating its recovery evidence', async () => {
        const memory = memoryFile();
        memory.files.set('/state/runs.json', '{TOKEN=do-not-expose');

        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);

        expect(() => store.getBySessionId('session-1'))
            .toThrow('autonomous quality gate store is unavailable');
        await expect(store.put('operation-1', { start, status, startedAt: 100, inputEpoch: 0 }))
            .rejects.toThrow('autonomous quality gate store is unavailable');
        try {
            store.getBySessionId('session-1');
        } catch (error) {
            expect(String(error)).not.toContain('do-not-expose');
        }
        expect(memory.renames).toHaveLength(0);
        expect(memory.files.get('/state/runs.json')).toBe('{TOKEN=do-not-expose');
    });

    it('rejects a persisted run whose record, start, and status owners disagree', async () => {
        const memory = memoryFile();
        const first = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        await first.put('operation-1', { start, status, startedAt: 100, inputEpoch: 0 });
        const corrupted = JSON.parse(memory.files.get('/state/runs.json')!) as {
            runs: Record<string, { status: AutonomousQualityGateStatusV1 }>;
        };
        corrupted.runs['session-1'].status = {
            ...corrupted.runs['session-1'].status,
            sessionId: 'session-2',
        };
        memory.files.set('/state/runs.json', JSON.stringify(corrupted));

        const restarted = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);

        expect(() => restarted.getBySessionId('session-1'))
            .toThrow('autonomous quality gate store is unavailable');
    });

    it('rehydrates an atomically persisted run after daemon restart', async () => {
        const memory = memoryFile();
        const first = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        const startOperationKeys = [`start:${'a'.repeat(64)}`, `start:${'b'.repeat(64)}`];
        const saved = await first.put('operation-1', {
            start, startOperationKeys, status, startedAt: 100, inputEpoch: 0,
            reportedTurns: 4, reportedTokens: 500, repairBaselineLastTurnEndAt: 90, pausedFrom: 'repairing',
        });

        const restarted = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);

        expect(saved).toMatchObject({ applied: true, operationSeq: 1 });
        expect(restarted.getBySessionId('session-1')).toMatchObject({
            start, startOperationKeys, status, operationSeq: 1,
            reportedTurns: 4, reportedTokens: 500, repairBaselineLastTurnEndAt: 90, pausedFrom: 'repairing',
        });
        expect(memory.renames).toHaveLength(1);
        expect(memory.renames[0][1]).toBe('/state/runs.json');
        expect(restarted.getActiveByDirectory('/repo', 'session-2')).toMatchObject({
            start: { sessionId: 'session-1' },
        });
    });

    it('returns the original operation for a duplicate request without overwriting the run', async () => {
        const memory = memoryFile();
        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        await store.put('operation-1', { start, status, startedAt: 100, inputEpoch: 0 });

        const duplicate = await store.put('operation-1', {
            start,
            status: { ...status, revision: 99 },
            startedAt: 999,
            inputEpoch: 99,
        });
        const next = await store.put('operation-2', {
            start,
            status: { ...status, revision: 1 },
            startedAt: 100,
            inputEpoch: 0,
        });

        expect(duplicate).toMatchObject({ applied: false, operationSeq: 1 });
        expect(next).toMatchObject({ applied: true, operationSeq: 2 });
        expect(store.getBySessionId('session-1')?.status.revision).toBe(1);
        expect(memory.renames).toHaveLength(2);
    });

    it('does not commit an operation in memory when the atomic write fails', async () => {
        const memory = memoryFile();
        const writeFile = vi.fn(memory.deps.writeFile)
            .mockRejectedValueOnce(new Error('disk full'));
        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', {
            ...memory.deps,
            writeFile,
        });

        await expect(store.put('operation-1', { start, status, startedAt: 100, inputEpoch: 0 }))
            .rejects.toThrow('disk full');
        expect(store.hasOperation('operation-1')).toBe(false);
        expect(store.getBySessionId('session-1')).toBeUndefined();

        await expect(store.put('operation-1', { start, status, startedAt: 100, inputEpoch: 0 }))
            .resolves.toMatchObject({ applied: true, operationSeq: 1 });
    });

    it('persists a bounded control result with its operation id', async () => {
        const memory = memoryFile();
        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        const result = { accepted: false, conflict: true, status };

        await store.put('resume-stale', { start, status, startedAt: 100, inputEpoch: 0 }, result);
        const restarted = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);

        expect(restarted.getOperationResult('resume-stale')).toEqual(result);
    });

    it('updates runtime snapshots without evicting operation dedupe entries', async () => {
        const memory = memoryFile();
        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        await store.put('control-request', { start, status, startedAt: 100, inputEpoch: 0 });

        for (let revision = 1; revision <= 300; revision += 1) {
            await store.update({
                start,
                status: { ...status, revision },
                startedAt: 100,
                inputEpoch: 0,
            });
        }

        expect(store.hasOperation('control-request')).toBe(true);
        expect(store.getBySessionId('session-1')?.status.revision).toBe(300);
    });

    it('bounds terminal run retention without evicting an older active writer', async () => {
        const memory = memoryFile();
        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        await store.put('active-operation', { start, status, startedAt: 100, inputEpoch: 0 });

        for (let index = 1; index <= 260; index += 1) {
            const sessionId = `terminal-${index}`;
            await store.put(`terminal-operation-${index}`, {
                start: { ...start, requestId: `request-${index}`, sessionId },
                status: {
                    ...status,
                    runId: `run-${index}`,
                    sessionId,
                    stage: 'stopped',
                    nextAction: 'none',
                },
                startedAt: 100 + index,
                inputEpoch: 0,
            });
        }

        expect(store.getBySessionId('session-1')).toBeDefined();
        expect(store.getBySessionId('terminal-1')).toBeUndefined();
        expect(store.getBySessionId('terminal-260')).toBeDefined();
    });

    it('retains an old active run when its newest snapshot becomes terminal', async () => {
        const memory = memoryFile();
        const store = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        await store.put('active-operation', { start, status, startedAt: 100, inputEpoch: 0 });

        for (let index = 1; index <= 260; index += 1) {
            const sessionId = `terminal-${index}`;
            await store.put(`terminal-operation-${index}`, {
                start: { ...start, requestId: `request-${index}`, sessionId },
                status: {
                    ...status,
                    runId: `run-${index}`,
                    sessionId,
                    stage: 'stopped',
                    nextAction: 'none',
                },
                startedAt: 100 + index,
                inputEpoch: 0,
            });
        }

        await store.update({
            start,
            status: { ...status, stage: 'stopped', nextAction: 'none' },
            startedAt: 100,
            inputEpoch: 0,
        });

        expect(store.getBySessionId('session-1')).toBeDefined();
        expect(store.getBySessionId('terminal-5')).toBeUndefined();
        expect(store.getBySessionId('terminal-260')).toBeDefined();
    });
});
