import { createHash, randomUUID } from 'node:crypto';
import type {
    AutonomousQualityGateControlRequestV1,
    AutonomousQualityGateStartRequestV1,
    AutonomousQualityGateStatusV1,
} from '../api/autonomousQualityGateProtocol';
import type { AutonomousWorktreeFingerprint } from './autonomousQualityGateFingerprint';
import { AutonomousQualityGateRuntime } from './autonomousQualityGateRuntime';
import type {
    AutonomousQualityGatePhasePlan,
    AutonomousQualityGatePhaseResult,
} from './autonomousQualityGateRunner';
import {
    MAX_START_OPERATION_KEYS,
    type AutonomousQualityGateControlResult,
    type AutonomousQualityGatePersistedRun,
    type AutonomousQualityGateRunStore,
} from './autonomousQualityGateStore';

interface RegistryStore {
    getBySessionId(sessionId: string): AutonomousQualityGatePersistedRun | undefined;
    hasSession?(sessionId: string): boolean;
    getByRunId(runId: string): AutonomousQualityGatePersistedRun | undefined;
    getActiveByDirectory(
        directory: string,
        exceptSessionId: string,
    ): AutonomousQualityGatePersistedRun | undefined;
    hasOperation(requestId: string): boolean;
    getOperationResult(requestId: string): AutonomousQualityGateControlResult | undefined;
    put(
        requestId: string,
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
        result?: AutonomousQualityGateControlResult,
    ): Promise<{ applied: boolean; operationSeq: number }>;
    update(
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
    ): Promise<{ operationSeq: number }>;
}

interface RegistryDependencies {
    store: RegistryStore | AutonomousQualityGateRunStore;
    capture(directory: string): Promise<AutonomousWorktreeFingerprint>;
    runPhase(
        phase: AutonomousQualityGatePhasePlan,
        cwd: string,
        signal: AbortSignal,
    ): Promise<AutonomousQualityGatePhaseResult>;
    sendRepair(
        sessionId: string,
        message: string,
        options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<void>;
    resolveSessionDirectory(sessionId: string, requestedDirectory: string): Promise<string | null>;
    isSessionIdle?(sessionId: string): boolean;
    getSessionRuntime?(sessionId: string): {
        idle: boolean;
        turns?: number;
        tokens?: number;
        lastTurnEndAt?: number;
    };
    onPersistenceError?: (error: unknown) => void;
    createRunId?: () => string;
    now?: () => number;
}

interface RuntimeEntry {
    start: AutonomousQualityGateStartRequestV1;
    startOperationKeys: Set<string>;
    runtime: AutonomousQualityGateRuntime;
    repairBaselineLastTurnEndAt?: number;
}

interface ActiveStart {
    candidateKey: string;
    operationKeys: Set<string>;
    aliasWrites: Promise<void>;
    aliasesEnabled: boolean;
    entry?: RuntimeEntry;
    promise: Promise<AutonomousQualityGateStatusV1>;
}

const STALE_START_ERROR = 'autonomous quality gate start request is stale';

export class AutonomousQualityGateDaemonRegistry {
    private readonly entries = new Map<string, RuntimeEntry>();
    private readonly starts = new Map<string, ActiveStart>();
    private readonly controls = new Map<string, Promise<AutonomousQualityGateControlResult>>();
    private readonly repairTurnObserved = new Set<string>();
    private readonly repairReady = new Set<string>();
    private notificationReadErrorReported = false;
    private notificationWriteErrorReported = false;

    constructor(private readonly deps: RegistryDependencies) {}

    start(request: AutonomousQualityGateStartRequestV1): Promise<AutonomousQualityGateStatusV1> {
        const candidateKey = startCandidateKey(request);
        const operationKey = scopedOperationKey(
            'start',
            request.sessionId,
            `${request.requestId}\0${candidateKey}`,
        );
        const active = this.starts.get(request.sessionId);
        if (active) {
            if (active.candidateKey !== candidateKey) {
                return active.promise.then(
                    () => this.start(request),
                    () => this.start(request),
                );
            }
            if (!active.operationKeys.has(operationKey)
                && this.isKnownPersistedStartOperation(request.sessionId, operationKey)) {
                return Promise.reject(new Error(STALE_START_ERROR));
            }
            if (active.operationKeys.has(operationKey)) return active.promise;
            rememberBoundedOperationKey(active.operationKeys, operationKey);
            const aliasWrite = active.entry && active.aliasesEnabled
                ? this.queueActiveStartAlias(active, operationKey)
                : Promise.resolve();
            return Promise.all([active.promise, aliasWrite]).then(([status]) => status);
        }
        const operationKeys = new Set([operationKey]);
        const pending: ActiveStart = {
            candidateKey,
            operationKeys,
            aliasWrites: Promise.resolve(),
            aliasesEnabled: false,
            promise: undefined as unknown as Promise<AutonomousQualityGateStatusV1>,
        };
        const attachEntry = (entry: RuntimeEntry): void => {
            pending.entry = entry;
        };
        const persistAliases = async (): Promise<void> => {
            pending.aliasesEnabled = true;
            for (const aliasKey of operationKeys) {
                if (!pending.entry?.startOperationKeys.has(aliasKey)) {
                    this.queueActiveStartAlias(pending, aliasKey);
                }
            }
            await pending.aliasWrites;
        };
        const operation = this.startOnce(request, operationKey, attachEntry, persistAliases).then(async (status) => {
            const entry = this.entries.get(request.sessionId);
            if (!entry) return status;
            while (true) {
                const observedWrites = pending.aliasWrites;
                await persistAliases();
                for (const aliasKey of operationKeys) {
                    if (!entry.startOperationKeys.has(aliasKey)) {
                        await this.persistStartOperation(aliasKey, entry);
                    }
                }
                if (pending.aliasWrites === observedWrites) break;
            }
            return entry.runtime.getStatus();
        });
        pending.promise = operation.finally(() => {
            if (this.starts.get(request.sessionId) === pending) this.starts.delete(request.sessionId);
        });
        this.starts.set(request.sessionId, pending);
        return pending.promise;
    }

    async status(sessionId: string): Promise<AutonomousQualityGateStatusV1 | null> {
        const persisted = this.deps.store.getBySessionId(sessionId);
        const entry = this.loadSession(sessionId);
        if (!entry) return null;
        const timedOut = entry.runtime.expireIfTimedOut();
        const snapshot = entry.runtime.snapshot();
        if (timedOut || JSON.stringify(snapshot.previousFailure) !== JSON.stringify(persisted?.previousFailure)) {
            await this.persistSnapshot(entry);
        }
        return entry.runtime.getStatus();
    }

    async control(request: AutonomousQualityGateControlRequestV1): Promise<unknown> {
        const entry = this.findRun(request.runId);
        if (!entry) return { accepted: false, notFound: true };
        const operationKey = scopedOperationKey(
            'control',
            request.runId,
            `${request.requestId}\0${request.action}\0${request.expectedRevision}`,
        );
        if (this.deps.store.hasOperation(operationKey)) {
            const original = this.deps.store.getOperationResult(operationKey);
            return original
                ? { ...original, duplicate: true }
                : { accepted: false, duplicate: true, conflict: true, status: entry.runtime.getStatus() };
        }
        const active = this.controls.get(operationKey);
        if (active) return { ...await active, duplicate: true };
        const operation = this.applyControl(entry, request, operationKey);
        this.controls.set(operationKey, operation);
        try {
            return await operation;
        } finally {
            if (this.controls.get(operationKey) === operation) this.controls.delete(operationKey);
        }
    }

    private async applyControl(
        entry: RuntimeEntry,
        request: AutonomousQualityGateControlRequestV1,
        operationKey: string,
    ): Promise<AutonomousQualityGateControlResult> {
        const result = entry.runtime.control(request.action, request.expectedRevision);
        try {
            await this.persistOperation(operationKey, entry, result);
            return result;
        } catch (error) {
            if (request.action === 'resume' && result.accepted) {
                entry.runtime.failClosedAfterResumePersistenceError();
            }
            throw error;
        }
    }

    noteSessionRuntime(sessionId: string, input: {
        idle: boolean;
        userInput: boolean;
        turns?: number;
        tokens?: number;
        lastTurnEndAt?: number;
    }): void {
        const entry = this.loadSessionForNotification(sessionId);
        if (!entry) return;
        if (input.userInput) entry.runtime.noteUserInput();
        entry.runtime.setSessionIdle(input.idle);
        const usageChanged = input.turns !== undefined || input.tokens !== undefined
            ? entry.runtime.recordSessionUsage({ turns: input.turns, tokens: input.tokens })
            : false;
        let repairBoundaryChanged = false;
        if (entry.runtime.isAwaitingRepairTurn()) {
            if (input.userInput || !input.idle) this.repairTurnObserved.add(sessionId);
            if (input.idle && (this.repairTurnObserved.has(sessionId)
                || completedAfter(input.lastTurnEndAt, entry.repairBaselineLastTurnEndAt))) {
                repairBoundaryChanged = !this.repairReady.has(sessionId);
                this.repairReady.add(sessionId);
            }
        }
        if (input.userInput || usageChanged || repairBoundaryChanged) {
            this.persistNotificationSnapshot(entry);
        }
    }

    noteSessionStopped(sessionId: string): void {
        const entry = this.loadSessionForNotification(sessionId);
        if (!entry) return;
        const status = entry.runtime.getStatus();
        entry.runtime.control('stop', status.revision);
        this.persistNotificationSnapshot(entry);
    }

    private loadSessionForNotification(sessionId: string): RuntimeEntry | undefined {
        try {
            const entry = this.loadSession(sessionId);
            this.notificationReadErrorReported = false;
            return entry;
        } catch (error) {
            if (!this.notificationReadErrorReported) {
                this.notificationReadErrorReported = true;
                this.reportPersistenceError(error);
            }
            return undefined;
        }
    }

    private persistNotificationSnapshot(entry: RuntimeEntry): void {
        void this.persistSnapshot(entry).then(
            () => { this.notificationWriteErrorReported = false; },
            (error) => {
                if (this.notificationWriteErrorReported) return;
                this.notificationWriteErrorReported = true;
                this.reportPersistenceError(error);
            },
        );
    }

    private reportPersistenceError(error: unknown): void {
        try {
            this.deps.onPersistenceError?.(error);
        } catch {
            // Notification diagnostics must not interrupt the session lifecycle.
        }
    }

    private async startOnce(
        request: AutonomousQualityGateStartRequestV1,
        operationKey: string,
        attachEntry: (entry: RuntimeEntry) => void,
        persistAliases: () => Promise<void>,
    ): Promise<AutonomousQualityGateStatusV1> {
        const persisted = this.deps.store.getBySessionId(request.sessionId);
        const replayPersisted = async (): Promise<AutonomousQualityGateStatusV1> => {
            const entry = this.loadSession(request.sessionId);
            if (entry) attachEntry(entry);
            const status = entry?.runtime.getStatus() ?? persisted!.status;
            if (!entry) return status;
            const returnReplay = async (): Promise<AutonomousQualityGateStatusV1> => {
                const snapshot = entry.runtime.snapshot();
                if (status.revision > persisted!.status.revision
                    || snapshot.inputEpoch !== persisted!.inputEpoch
                    || snapshot.reportedTurns !== (persisted!.reportedTurns ?? 0)
                    || snapshot.reportedTokens !== (persisted!.reportedTokens ?? 0)
                    || snapshot.pausedFrom !== (persisted!.pausedFrom ?? 'awaiting-completion')
                    || JSON.stringify(snapshot.previousFailure) !== JSON.stringify(persisted!.previousFailure)
                    || entry.repairBaselineLastTurnEndAt !== persisted!.repairBaselineLastTurnEndAt) {
                    await this.persistSnapshot(entry);
                }
                return status;
            };
            const sessionRuntime = this.sessionRuntime(request.sessionId);
            const waitingCandidate = status.stage === 'awaiting-completion'
                && status.fingerprintChanged !== true;
            const completedRepair = awaitingRepairTurn(status.stage)
                && (this.repairReady.has(request.sessionId) || completedAfter(
                    sessionRuntime.lastTurnEndAt,
                    entry.repairBaselineLastTurnEndAt,
                ));
            if (!waitingCandidate && !completedRepair) {
                return returnReplay();
            }
            const directory = await this.deps.resolveSessionDirectory(request.sessionId, request.directory);
            if (!directory || directory !== entry.start.directory) {
                throw new Error('autonomous quality gate session directory mismatch');
            }
            this.repairReady.delete(request.sessionId);
            this.repairTurnObserved.delete(request.sessionId);
            entry.runtime.setSessionIdle(sessionRuntime.idle);
            entry.runtime.recordSessionUsage({ turns: sessionRuntime.turns, tokens: sessionRuntime.tokens });
            entry.repairBaselineLastTurnEndAt = undefined;
            const resumed = await entry.runtime.onCompletionCandidate();
            if (entry.runtime.isAwaitingRepairTurn()) {
                entry.repairBaselineLastTurnEndAt = sessionRuntime.lastTurnEndAt;
            }
            await this.persistSnapshot(entry);
            return resumed;
        };
        if (persisted?.startOperationKeys?.includes(operationKey)) {
            return replayPersisted();
        }
        if (this.deps.store.hasOperation(operationKey)) {
            if (persisted && !persisted.startOperationKeys && sameStartOperation(persisted.start, request)) {
                return replayPersisted();
            }
            throw new Error(STALE_START_ERROR);
        }
        if (persisted && sameStartOperation(persisted.start, request)) {
            return replayPersisted();
        }

        const directory = await this.deps.resolveSessionDirectory(request.sessionId, request.directory);
        if (!directory) throw new Error('autonomous quality gate session directory mismatch');
        const canonicalRequest = directory === request.directory ? request : { ...request, directory };
        if (persisted && sameStartOperation(persisted.start, canonicalRequest)) {
            return replayPersisted();
        }

        const conflictingWriter = await this.hasConflictingWriter(directory, request.sessionId);
        if (conflictingWriter) {
            const previous = this.entries.get(request.sessionId);
            const blocked = this.createEntry(canonicalRequest);
            attachEntry(blocked);
            blocked.runtime.block('worktree-in-use');
            try {
                await this.persistStartOperation(operationKey, blocked);
                await persistAliases();
            } catch (error) {
                this.restoreEntryAfterFailedCreate(request.sessionId, blocked, previous);
                throw error;
            }
            return blocked.runtime.getStatus();
        }

        const existing = this.loadSession(request.sessionId);
        const entry = !existing || isTerminal(existing.runtime.getStatus().stage)
            ? this.createEntry(canonicalRequest)
            : existing;
        attachEntry(entry);
        const created = entry !== existing;
        const sessionRuntime = this.sessionRuntime(request.sessionId);
        const repairCompleted = completedAfter(
            sessionRuntime.lastTurnEndAt,
            entry.repairBaselineLastTurnEndAt,
        );
        if (awaitingRepairTurn(entry.runtime.getStatus().stage)
            && !repairCompleted
            && !this.repairReady.has(request.sessionId)) {
            await this.persistStartOperation(operationKey, entry);
            await persistAliases();
            return entry.runtime.getStatus();
        }
        this.repairReady.delete(request.sessionId);
        this.repairTurnObserved.delete(request.sessionId);
        entry.runtime.setSessionIdle(sessionRuntime.idle);
        entry.runtime.recordSessionUsage({ turns: sessionRuntime.turns, tokens: sessionRuntime.tokens });
        entry.repairBaselineLastTurnEndAt = undefined;
        try {
            await this.persistStartOperation(operationKey, entry);
            await persistAliases();
        } catch (error) {
            if (created) this.restoreEntryAfterFailedCreate(request.sessionId, entry, existing);
            throw error;
        }
        const status = await entry.runtime.onCompletionCandidate();
        if (entry.runtime.isAwaitingRepairTurn()) {
            entry.repairBaselineLastTurnEndAt = sessionRuntime.lastTurnEndAt;
        }
        await this.persistSnapshot(entry);
        return status;
    }

    private loadSession(sessionId: string): RuntimeEntry | undefined {
        const loaded = this.entries.get(sessionId);
        if (loaded) return loaded;
        const persisted = this.deps.store.getBySessionId(sessionId);
        if (!persisted) return undefined;
        const entry = this.createEntry(persisted.start, persisted);
        this.entries.set(sessionId, entry);
        return entry;
    }

    private findRun(runId: string): RuntimeEntry | undefined {
        const loaded = [...this.entries.values()].find(entry => entry.runtime.getStatus().runId === runId);
        if (loaded) return loaded;
        const persisted = this.deps.store.getByRunId(runId);
        return persisted ? this.loadSession(persisted.start.sessionId) : undefined;
    }

    private createEntry(
        start: AutonomousQualityGateStartRequestV1,
        persisted?: AutonomousQualityGatePersistedRun,
    ): RuntimeEntry {
        const initialSessionRuntime = this.sessionRuntime(start.sessionId);
        let entry: RuntimeEntry;
        const runtime = new AutonomousQualityGateRuntime(start, {
            runId: persisted?.status.runId ?? this.deps.createRunId?.() ?? randomUUID(),
            now: this.deps.now,
            capture: () => this.deps.capture(start.directory),
            runPhase: (phase, signal) => this.deps.runPhase(phase, start.directory, signal),
            sendRepair: (message, options) => this.deps.sendRepair(start.sessionId, message, options),
            onRepairAdmission: () => {
                entry.repairBaselineLastTurnEndAt = this.sessionRuntime(start.sessionId).lastTurnEndAt;
            },
            checkpoint: async () => {
                const status = entry.runtime.getStatus();
                await this.persistOperation(
                    scopedOperationKey('effect', status.runId, String(status.revision)),
                    entry,
                );
            },
            initialSessionUsage: {
                turns: initialSessionRuntime.turns ?? 0,
                tokens: initialSessionRuntime.tokens ?? 0,
            },
            ...(persisted ? {
                restored: {
                    status: persisted.status,
                    startedAt: persisted.startedAt,
                    inputEpoch: persisted.inputEpoch,
                    reportedTurns: persisted.reportedTurns ?? 0,
                    reportedTokens: persisted.reportedTokens ?? 0,
                    pausedFrom: persisted.pausedFrom ?? 'awaiting-completion',
                    previousFailure: persisted.previousFailure,
                },
            } : {}),
        });
        entry = {
            start,
            startOperationKeys: new Set(persisted?.startOperationKeys),
            runtime,
            repairBaselineLastTurnEndAt: persisted?.repairBaselineLastTurnEndAt,
        };
        this.entries.set(start.sessionId, entry);
        return entry;
    }

    private queueActiveStartAlias(active: ActiveStart, operationKey: string): Promise<void> {
        const entry = active.entry;
        if (!entry) return Promise.resolve();
        const write = active.aliasWrites.then(async () => {
            if (!entry.startOperationKeys.has(operationKey)) {
                await this.persistStartOperation(operationKey, entry);
            }
        });
        active.aliasWrites = write.catch(() => undefined);
        return write;
    }

    private async persistStartOperation(operationKey: string, entry: RuntimeEntry): Promise<void> {
        const alreadyKnown = entry.startOperationKeys.has(operationKey);
        const previousKeys = alreadyKnown ? undefined : [...entry.startOperationKeys];
        this.rememberStartOperation(entry, operationKey);
        try {
            await this.persistOperation(operationKey, entry);
        } catch (error) {
            if (previousKeys) {
                entry.startOperationKeys.clear();
                for (const key of previousKeys) entry.startOperationKeys.add(key);
            }
            throw error;
        }
    }

    private rememberStartOperation(entry: RuntimeEntry, operationKey: string): void {
        rememberBoundedOperationKey(entry.startOperationKeys, operationKey);
    }

    private isKnownPersistedStartOperation(sessionId: string, operationKey: string): boolean {
        if (this.deps.store.hasOperation(operationKey)) return true;
        return this.deps.store.getBySessionId(sessionId)?.startOperationKeys?.includes(operationKey) ?? false;
    }

    private async persistOperation(
        requestId: string,
        entry: RuntimeEntry,
        result?: AutonomousQualityGateControlResult,
    ): Promise<void> {
        const snapshot = entry.runtime.snapshot();
        await this.deps.store.put(requestId, {
            start: entry.start,
            startOperationKeys: [...entry.startOperationKeys],
            status: snapshot.status,
            startedAt: snapshot.startedAt,
            inputEpoch: snapshot.inputEpoch,
            reportedTurns: snapshot.reportedTurns,
            reportedTokens: snapshot.reportedTokens,
            pausedFrom: snapshot.pausedFrom,
            repairBaselineLastTurnEndAt: entry.repairBaselineLastTurnEndAt,
            previousFailure: snapshot.previousFailure,
        }, result);
        this.pruneEvictedTerminalEntries();
    }

    private async persistSnapshot(entry: RuntimeEntry): Promise<void> {
        const snapshot = entry.runtime.snapshot();
        await this.deps.store.update({
            start: entry.start,
            startOperationKeys: [...entry.startOperationKeys],
            status: snapshot.status,
            startedAt: snapshot.startedAt,
            inputEpoch: snapshot.inputEpoch,
            reportedTurns: snapshot.reportedTurns,
            reportedTokens: snapshot.reportedTokens,
            pausedFrom: snapshot.pausedFrom,
            repairBaselineLastTurnEndAt: entry.repairBaselineLastTurnEndAt,
            previousFailure: snapshot.previousFailure,
        });
        this.pruneEvictedTerminalEntries();
    }

    private pruneEvictedTerminalEntries(): void {
        for (const [sessionId, entry] of this.entries) {
            if (this.starts.has(sessionId) || !isTerminal(entry.runtime.getStatus().stage)) continue;
            const retained = this.deps.store.hasSession?.(sessionId)
                ?? this.deps.store.getBySessionId(sessionId) !== undefined;
            if (retained) continue;
            this.entries.delete(sessionId);
            this.repairTurnObserved.delete(sessionId);
            this.repairReady.delete(sessionId);
        }
    }

    private hasActiveEntryByDirectory(
        directory: string,
        exceptSessionId: string,
    ): boolean {
        return [...this.entries.values()].some(candidate => (
            candidate.start.directory === directory
            && candidate.start.sessionId !== exceptSessionId
            && !isTerminal(candidate.runtime.getStatus().stage)
        ));
    }

    private async hasConflictingWriter(directory: string, exceptSessionId: string): Promise<boolean> {
        if (this.hasActiveEntryByDirectory(directory, exceptSessionId)) return true;
        while (true) {
            const persisted = this.deps.store.getActiveByDirectory(directory, exceptSessionId);
            if (!persisted) return false;
            const entry = this.loadSession(persisted.start.sessionId);
            if (!entry || !isTerminal(entry.runtime.getStatus().stage)) return true;
            // A persisted `verifying` snapshot becomes terminal when restored because the
            // interrupted external effect cannot be replayed safely. Persist that recovery
            // before checking the worktree again so it cannot remain a phantom writer.
            await this.persistSnapshot(entry);
        }
    }

    private restoreEntryAfterFailedCreate(
        sessionId: string,
        failed: RuntimeEntry,
        previous: RuntimeEntry | undefined,
    ): void {
        if (this.entries.get(sessionId) !== failed) return;
        if (previous) this.entries.set(sessionId, previous);
        else this.entries.delete(sessionId);
    }

    private sessionRuntime(sessionId: string): {
        idle: boolean;
        turns?: number;
        tokens?: number;
        lastTurnEndAt?: number;
    } {
        return this.deps.getSessionRuntime?.(sessionId) ?? {
            idle: this.deps.isSessionIdle?.(sessionId) ?? false,
            turns: 0,
            tokens: 0,
        };
    }
}

function awaitingRepairTurn(stage: AutonomousQualityGateStatusV1['stage']): boolean {
    return stage === 'repairing' || stage === 'unchanged-after-failure';
}

function completedAfter(current: number | undefined, baseline: number | undefined): boolean {
    return current !== undefined && baseline !== undefined && current > baseline;
}

function isTerminal(stage: AutonomousQualityGateStatusV1['stage']): boolean {
    return stage === 'passed' || stage === 'stopped' || stage === 'blocked' || stage === 'limit-reached';
}

function scopedOperationKey(kind: 'start' | 'control' | 'effect', ownerId: string, requestId: string): string {
    const digest = createHash('sha256')
        .update(ownerId)
        .update('\0')
        .update(requestId)
        .digest('hex');
    return `${kind}:${digest}`;
}

function startCandidateKey(request: AutonomousQualityGateStartRequestV1): string {
    return JSON.stringify({
        sessionId: request.sessionId,
        projectId: request.projectId,
        directory: request.directory,
        recipeRevision: request.recipeRevision,
        plan: request.plan,
        limits: request.limits,
    });
}

function sameStartOperation(
    left: AutonomousQualityGateStartRequestV1,
    right: AutonomousQualityGateStartRequestV1,
): boolean {
    return left.requestId === right.requestId && startCandidateKey(left) === startCandidateKey(right);
}

function rememberBoundedOperationKey(keys: Set<string>, operationKey: string): void {
    if (keys.has(operationKey)) return;
    keys.add(operationKey);
    if (keys.size <= MAX_START_OPERATION_KEYS) return;
    const [oldestOperation] = keys;
    keys.delete(oldestOperation ?? operationKey);
}
