import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
    AutonomousQualityGateStartRequestV1Schema,
    AutonomousQualityGateStatusV1Schema,
    type AutonomousQualityGateStartRequestV1,
    type AutonomousQualityGateStatusV1,
} from '../api/autonomousQualityGateProtocol';
import type { AutonomousPreviousGateFailure } from './autonomousQualityGateRetry';

const MAX_OPERATION_JOURNAL_ENTRIES = 256;

const PersistedRunSchema = z.object({
    start: AutonomousQualityGateStartRequestV1Schema,
    status: AutonomousQualityGateStatusV1Schema,
    startedAt: z.number().int().min(0),
    inputEpoch: z.number().int().min(0),
    previousFailure: z.object({
        attempt: z.number().int().min(1),
        fingerprint: z.string().min(1),
        result: z.object({
            name: z.enum(['bootstrap', 'build', 'test', 'start']),
            status: z.enum(['passed', 'failed', 'timed-out', 'aborted']),
            exitCode: z.number().int().nullable(),
            timedOut: z.boolean(),
            durationMs: z.number().min(0),
            stdoutTail: z.string(),
            stderrTail: z.string(),
            outputTruncated: z.boolean(),
        }),
    }).optional(),
    operationSeq: z.number().int().min(1),
});

const StoreFileSchema = z.object({
    version: z.literal(1),
    nextOperationSeq: z.number().int().min(1),
    runs: z.record(z.string(), PersistedRunSchema),
    operations: z.array(z.object({
        requestId: z.string().min(1).max(128),
        operationSeq: z.number().int().min(1),
    })).max(MAX_OPERATION_JOURNAL_ENTRIES),
});

export interface AutonomousQualityGatePersistedRun {
    start: AutonomousQualityGateStartRequestV1;
    status: AutonomousQualityGateStatusV1;
    startedAt: number;
    inputEpoch: number;
    previousFailure?: AutonomousPreviousGateFailure;
    operationSeq: number;
}

type StoreFile = z.infer<typeof StoreFileSchema>;

interface StoreDependencies {
    readFile(path: string): Promise<string>;
    writeFile(path: string, value: string, options: { mode: number }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: StoreDependencies = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: async (path, value, options) => { await writeFile(path, value, options); },
    rename,
    mkdir,
};

export class AutonomousQualityGateRunStore {
    private writeQueue = Promise.resolve();

    private constructor(
        private readonly filePath: string,
        private readonly deps: StoreDependencies,
        private state: StoreFile,
    ) {}

    static async open(
        filePath: string,
        dependencies: StoreDependencies = DEFAULT_DEPENDENCIES,
    ): Promise<AutonomousQualityGateRunStore> {
        let state: StoreFile = { version: 1, nextOperationSeq: 1, runs: {}, operations: [] };
        try {
            state = StoreFileSchema.parse(JSON.parse(await dependencies.readFile(filePath)));
        } catch (error) {
            if (!isMissingFile(error)) throw error;
        }
        return new AutonomousQualityGateRunStore(filePath, dependencies, state);
    }

    getBySessionId(sessionId: string): AutonomousQualityGatePersistedRun | undefined {
        const run = this.state.runs[sessionId];
        return run ? structuredClone(run) : undefined;
    }

    getByRunId(runId: string): AutonomousQualityGatePersistedRun | undefined {
        const run = Object.values(this.state.runs).find(candidate => candidate.status.runId === runId);
        return run ? structuredClone(run) : undefined;
    }

    hasOperation(requestId: string): boolean {
        return this.state.operations.some(operation => operation.requestId === requestId);
    }

    put(
        requestId: string,
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
    ): Promise<{ applied: boolean; operationSeq: number }> {
        const operation = this.writeQueue.then(() => this.putLocked(requestId, run));
        this.writeQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async putLocked(
        requestId: string,
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
    ): Promise<{ applied: boolean; operationSeq: number }> {
        const duplicate = this.state.operations.find(operation => operation.requestId === requestId);
        if (duplicate) return { applied: false, operationSeq: duplicate.operationSeq };

        const operationSeq = this.state.nextOperationSeq;
        const persisted = PersistedRunSchema.parse({ ...run, operationSeq });
        this.state = StoreFileSchema.parse({
            ...this.state,
            nextOperationSeq: operationSeq + 1,
            runs: { ...this.state.runs, [run.start.sessionId]: persisted },
            operations: [
                ...this.state.operations,
                { requestId, operationSeq },
            ].slice(-MAX_OPERATION_JOURNAL_ENTRIES),
        });
        await this.persist();
        return { applied: true, operationSeq };
    }

    private async persist(): Promise<void> {
        await this.deps.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await this.deps.writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
        await this.deps.rename(tempPath, this.filePath);
    }
}

function isMissingFile(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
