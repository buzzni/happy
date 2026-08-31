import { describe, expect, it } from 'vitest';
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
    it('rehydrates an atomically persisted run after daemon restart', async () => {
        const memory = memoryFile();
        const first = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);
        const saved = await first.put('operation-1', { start, status, startedAt: 100, inputEpoch: 0 });

        const restarted = await AutonomousQualityGateRunStore.open('/state/runs.json', memory.deps);

        expect(saved).toMatchObject({ applied: true, operationSeq: 1 });
        expect(restarted.getBySessionId('session-1')).toMatchObject({ start, status, operationSeq: 1 });
        expect(memory.renames).toHaveLength(1);
        expect(memory.renames[0][1]).toBe('/state/runs.json');
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
});
