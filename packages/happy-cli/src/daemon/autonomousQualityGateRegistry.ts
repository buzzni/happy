import { randomUUID } from 'node:crypto';
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
import type {
    AutonomousQualityGatePersistedRun,
    AutonomousQualityGateRunStore,
} from './autonomousQualityGateStore';

interface RegistryStore {
    getBySessionId(sessionId: string): AutonomousQualityGatePersistedRun | undefined;
    getByRunId(runId: string): AutonomousQualityGatePersistedRun | undefined;
    hasOperation(requestId: string): boolean;
    put(
        requestId: string,
        run: Omit<AutonomousQualityGatePersistedRun, 'operationSeq'>,
    ): Promise<{ applied: boolean; operationSeq: number }>;
}

interface RegistryDependencies {
    store: RegistryStore | AutonomousQualityGateRunStore;
    capture(directory: string): Promise<AutonomousWorktreeFingerprint>;
    runPhase(
        phase: AutonomousQualityGatePhasePlan,
        cwd: string,
        signal: AbortSignal,
    ): Promise<AutonomousQualityGatePhaseResult>;
    sendRepair(sessionId: string, message: string): Promise<void>;
    isSessionIdle(sessionId: string): boolean;
    createRunId?: () => string;
    now?: () => number;
}

interface RuntimeEntry {
    start: AutonomousQualityGateStartRequestV1;
    runtime: AutonomousQualityGateRuntime;
}

export class AutonomousQualityGateDaemonRegistry {
    private readonly entries = new Map<string, RuntimeEntry>();
    private readonly starts = new Map<string, Promise<AutonomousQualityGateStatusV1>>();
    private readonly repairTurnObserved = new Set<string>();
    private readonly repairReady = new Set<string>();

    constructor(private readonly deps: RegistryDependencies) {}

    start(request: AutonomousQualityGateStartRequestV1): Promise<AutonomousQualityGateStatusV1> {
        const active = this.starts.get(request.requestId);
        if (active) return active;
        const operation = this.startOnce(request).finally(() => this.starts.delete(request.requestId));
        this.starts.set(request.requestId, operation);
        return operation;
    }

    async status(sessionId: string): Promise<AutonomousQualityGateStatusV1 | null> {
        return this.loadSession(sessionId)?.runtime.getStatus() ?? null;
    }

    async control(request: AutonomousQualityGateControlRequestV1): Promise<unknown> {
        const entry = this.findRun(request.runId);
        if (!entry) return { accepted: false, notFound: true };
        if (this.deps.store.hasOperation(request.requestId)) {
            return { accepted: true, duplicate: true, status: entry.runtime.getStatus() };
        }
        const result = entry.runtime.control(request.action, request.expectedRevision);
        await this.persist(request.requestId, entry);
        return result;
    }

    noteSessionRuntime(sessionId: string, input: { idle: boolean; userInput: boolean }): void {
        const entry = this.loadSession(sessionId);
        if (!entry) return;
        if (input.userInput) entry.runtime.noteUserInput();
        entry.runtime.setSessionIdle(input.idle);
        if (entry.runtime.getStatus().stage === 'repairing') {
            if (input.userInput || !input.idle) this.repairTurnObserved.add(sessionId);
            if (input.idle && this.repairTurnObserved.has(sessionId)) this.repairReady.add(sessionId);
        }
        void this.persist(`runtime-${sessionId}-${randomUUID()}`, entry);
    }

    private async startOnce(request: AutonomousQualityGateStartRequestV1): Promise<AutonomousQualityGateStatusV1> {
        const persisted = this.deps.store.getBySessionId(request.sessionId);
        if (this.deps.store.hasOperation(request.requestId) && persisted) return persisted.status;

        const entry = this.loadSession(request.sessionId) ?? this.createEntry(request);
        if (entry.runtime.getStatus().stage === 'repairing' && !this.repairReady.has(request.sessionId)) {
            return entry.runtime.getStatus();
        }
        this.repairReady.delete(request.sessionId);
        this.repairTurnObserved.delete(request.sessionId);
        entry.runtime.setSessionIdle(this.deps.isSessionIdle(request.sessionId));
        await this.persist(request.requestId, entry);
        const status = await entry.runtime.onCompletionCandidate();
        await this.persist(`${request.requestId}:result:${status.revision}`, entry);
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
        const runtime = new AutonomousQualityGateRuntime(start, {
            runId: persisted?.status.runId ?? this.deps.createRunId?.() ?? randomUUID(),
            now: this.deps.now,
            capture: () => this.deps.capture(start.directory),
            runPhase: (phase, signal) => this.deps.runPhase(phase, start.directory, signal),
            sendRepair: message => this.deps.sendRepair(start.sessionId, message),
            ...(persisted ? {
                restored: {
                    status: persisted.status,
                    startedAt: persisted.startedAt,
                    inputEpoch: persisted.inputEpoch,
                    previousFailure: persisted.previousFailure,
                },
            } : {}),
        });
        const entry = { start, runtime };
        this.entries.set(start.sessionId, entry);
        return entry;
    }

    private async persist(requestId: string, entry: RuntimeEntry): Promise<void> {
        const snapshot = entry.runtime.snapshot();
        await this.deps.store.put(requestId, {
            start: entry.start,
            status: snapshot.status,
            startedAt: snapshot.startedAt,
            inputEpoch: snapshot.inputEpoch,
            previousFailure: snapshot.previousFailure,
        });
    }
}
