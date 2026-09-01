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
const MAX_RETAINED_TERMINAL_RUNS = 256;
export const MAX_START_OPERATION_KEYS = MAX_OPERATION_JOURNAL_ENTRIES;

const ControlResultSchema = z.object({
    accepted: z.boolean(),
    conflict: z.boolean().optional(),
    status: AutonomousQualityGateStatusV1Schema,
});

const PersistedRunSchema = z.object({
    start: AutonomousQualityGateStartRequestV1Schema,
    startOperationKeys: z.array(z.string().regex(/^start:[a-f0-9]{64}$/))
        .max(MAX_START_OPERATION_KEYS)
        .optional(),
    status: AutonomousQualityGateStatusV1Schema,
    startedAt: z.number().int().min(0),
    inputEpoch: z.number().int().min(0),
    reportedTurns: z.number().int().min(0).optional(),
    reportedTokens: z.number().int().min(0).optional(),
    repairBaselineLastTurnEndAt: z.number().int().min(0).optional(),
    pausedFrom: z.enum([
        'awaiting-completion', 'verifying', 'repairing', 'unchanged-after-failure', 'passed',
        'paused', 'stopped', 'blocked', 'limit-reached',
    ]).optional(),
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
        result: ControlResultSchema.optional(),
    })).max(MAX_OPERATION_JOURNAL_ENTRIES),
}).superRefine((store, context) => {
    for (const [sessionId, run] of Object.entries(store.runs)) {
        if (run.start.sessionId !== sessionId || run.status.sessionId !== sessionId) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['runs', sessionId],
                message: 'persisted run session owner mismatch',
            });
        }
        if (run.status.projectId !== run.start.projectId) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['runs', sessionId],
                message: 'persisted run project owner mismatch',
            });
        }
    }
});

export interface AutonomousQualityGatePersistedRun {
    start: AutonomousQualityGateStartRequestV1;
    startOperationKeys?: string[];
    status: AutonomousQualityGateStatusV1;
    startedAt: number;
    inputEpoch: number;
    reportedTurns?: number;
    reportedTokens?: number;
    repairBaselineLastTurnEndAt?: number;
    pausedFrom?: AutonomousQualityGateStatusV1['stage'];
    previousFailure?: AutonomousPreviousGateFailure;
    operationSeq: number;
}

export interface AutonomousQualityGateControlResult {
    accepted: boolean;
    conflict?: boolean;
    status: AutonomousQualityGateStatusV1;
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
        private readonly unavailableError?: Error,
    ) {}

    static async open(
        filePath: string,
        dependencies: StoreDependencies = DEFAULT_DEPENDENCIES,
    ): Promise<AutonomousQualityGateRunStore> {
        let state: StoreFile = { version: 1, nextOperationSeq: 1, runs: {}, operations: [] };
        let unavailableError: Error | undefined;
        try {
            state = StoreFileSchema.parse(JSON.parse(await dependencies.readFile(filePath)));
        } catch (error) {
            if (!isMissingFile(error)) {
                unavailableError = new Error('autonomous quality gate store is unavailable');
            }
        }
        return new AutonomousQualityGateRunStore(filePath, dependencies, state, unavailableError);
    }

    getBySessionId(sessionId: string): AutonomousQualityGatePersistedRun | undefined {
        this.assertAvailable();
        const run = this.state.runs[sessionId];
        return run ? structuredClone(run) : undefined;
    }

    hasSession(sessionId: string): boolean {
        this.assertAvailable();
        return this.state.runs[sessionId] !== undefined;
    }

    getByRunId(runId: string): AutonomousQualityGatePersistedRun | undefined {
        this.assertAvailable();
        const run = Object.values(this.state.runs).find(candidate => candidate.status.runId === runId);
        return run ? structuredClone(run) : undefined;
    }

    getActiveByDirectory(
        directory: string,
        exceptSessionId: string,
    ): AutonomousQualityGatePersistedRun | undefined {
        this.assertAvailable();
        const run = Object.values(this.state.runs).find(candidate => (
            candidate.start.directory === directory
            && candidate.start.sessionId !== exceptSessionId
            && !isTerminalStage(candidate.status.stage)
        ));
        return run ? structuredClone(run) : undefined;
    }

    hasOperation(requestId: string): boolean {
        this.assertAvailable();
        return this.state.operations.some(operation => operation.requestId === requestId);
    }

    getOperationResult(requestId: string): AutonomousQualityGateControlResult | undefined {
        this.assertAvailable();
        const result = this.state.operations.find(operation => operation.requestId === requestId)?.result;
        return result ? structuredClone(result) : undefined;
    }

    put(
        requestId: string,
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
        result?: AutonomousQualityGateControlResult,
    ): Promise<{ applied: boolean; operationSeq: number }> {
        if (this.unavailableError) return Promise.reject(this.unavailableError);
        const operation = this.writeQueue.then(() => this.putLocked(requestId, run, result));
        this.writeQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    update(
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
    ): Promise<{ operationSeq: number }> {
        if (this.unavailableError) return Promise.reject(this.unavailableError);
        const operation = this.writeQueue.then(() => this.updateLocked(run));
        this.writeQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async putLocked(
        requestId: string,
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
        result?: AutonomousQualityGateControlResult,
    ): Promise<{ applied: boolean; operationSeq: number }> {
        const duplicate = this.state.operations.find(operation => operation.requestId === requestId);
        if (duplicate) return { applied: false, operationSeq: duplicate.operationSeq };

        const operationSeq = this.state.nextOperationSeq;
        const persisted = PersistedRunSchema.parse({ ...run, operationSeq });
        const operations = [
            ...this.state.operations,
            { requestId, operationSeq, ...(result ? { result: ControlResultSchema.parse(result) } : {}) },
        ].slice(-MAX_OPERATION_JOURNAL_ENTRIES);
        const nextState = StoreFileSchema.parse({
            ...this.state,
            nextOperationSeq: operationSeq + 1,
            runs: retainBoundedTerminalRuns(
                { ...this.state.runs, [run.start.sessionId]: persisted },
                run.start.sessionId,
            ),
            operations,
        });
        await this.persist(nextState);
        this.state = nextState;
        return { applied: true, operationSeq };
    }

    private async updateLocked(
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
    ): Promise<{ operationSeq: number }> {
        const current = this.state.runs[run.start.sessionId];
        if (!current) throw new Error(`autonomous quality gate run not found: ${run.start.sessionId}`);
        const persisted = PersistedRunSchema.parse({ ...run, operationSeq: current.operationSeq });
        const nextState = StoreFileSchema.parse({
            ...this.state,
            runs: retainBoundedTerminalRuns(
                { ...this.state.runs, [run.start.sessionId]: persisted },
                run.start.sessionId,
            ),
        });
        await this.persist(nextState);
        this.state = nextState;
        return { operationSeq: current.operationSeq };
    }

    private async persist(state: StoreFile): Promise<void> {
        await this.deps.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await this.deps.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await this.deps.rename(tempPath, this.filePath);
    }

    private assertAvailable(): void {
        if (this.unavailableError) throw this.unavailableError;
    }
}

function isTerminalStage(stage: AutonomousQualityGateStatusV1['stage']): boolean {
    return stage === 'passed' || stage === 'stopped' || stage === 'blocked' || stage === 'limit-reached';
}

function retainBoundedTerminalRuns(
    runs: StoreFile['runs'],
    newestSessionId: string,
): StoreFile['runs'] {
    const terminal = Object.entries(runs)
        .filter(([, run]) => isTerminalStage(run.status.stage))
        .sort(([leftSessionId, left], [rightSessionId, right]) => {
            if (leftSessionId === newestSessionId) return -1;
            if (rightSessionId === newestSessionId) return 1;
            return right.operationSeq - left.operationSeq;
        });
    if (terminal.length <= MAX_RETAINED_TERMINAL_RUNS) return runs;
    const next = { ...runs };
    for (const [sessionId] of terminal.slice(MAX_RETAINED_TERMINAL_RUNS)) delete next[sessionId];
    return next;
}

function isMissingFile(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
