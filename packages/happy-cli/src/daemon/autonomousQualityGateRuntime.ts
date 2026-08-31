import type {
    AutonomousQualityGateStartRequestV1,
    AutonomousQualityGateStatusV1,
} from '../api/autonomousQualityGateProtocol';
import { AutonomousQualityGateAdmission } from './autonomousQualityGateAdmission';
import {
    consumeAutonomousQualityGateBudget,
    createAutonomousQualityGateBudgetUsage,
    findAutonomousQualityGateLimit,
} from './autonomousQualityGateBudget';
import {
    buildAutonomousGateFailureArtifact,
    serializeAutonomousGateFailureContinuation,
} from './autonomousQualityGateFailureArtifact';
import type { AutonomousWorktreeFingerprint } from './autonomousQualityGateFingerprint';
import {
    runAutonomousQualityGateAttempt,
    type AutonomousPreviousGateFailure,
} from './autonomousQualityGateRetry';
import type {
    AutonomousQualityGatePhasePlan,
    AutonomousQualityGatePhaseResult,
} from './autonomousQualityGateRunner';

interface AutonomousQualityGateRuntimeDependencies {
    runId: string;
    now?: () => number;
    capture: () => Promise<AutonomousWorktreeFingerprint>;
    runPhase: (
        phase: AutonomousQualityGatePhasePlan,
        signal: AbortSignal,
    ) => Promise<AutonomousQualityGatePhaseResult>;
    sendRepair: (message: string) => Promise<void>;
    restored?: AutonomousQualityGateRuntimeSnapshot;
}

export interface AutonomousQualityGateRuntimeSnapshot {
    status: AutonomousQualityGateStatusV1;
    startedAt: number;
    inputEpoch: number;
    previousFailure?: AutonomousPreviousGateFailure;
}

export class AutonomousQualityGateRuntime {
    private readonly admission: AutonomousQualityGateAdmission;
    private readonly startedAt: number;
    private readonly now: () => number;
    private previousFailure?: AutonomousPreviousGateFailure;
    private pausedFrom: AutonomousQualityGateStatusV1['stage'] = 'awaiting-completion';
    private status: AutonomousQualityGateStatusV1;

    constructor(
        private readonly request: AutonomousQualityGateStartRequestV1,
        private readonly deps: AutonomousQualityGateRuntimeDependencies,
    ) {
        this.now = deps.now ?? Date.now;
        this.startedAt = deps.restored?.startedAt ?? this.now();
        this.admission = new AutonomousQualityGateAdmission(deps.restored?.inputEpoch);
        this.previousFailure = deps.restored?.previousFailure;
        this.status = deps.restored?.status ?? {
            schemaVersion: 1,
            runId: deps.runId,
            revision: 0,
            sessionId: request.sessionId,
            projectId: request.projectId,
            stage: 'awaiting-completion',
            attempt: 0,
            usage: createAutonomousQualityGateBudgetUsage(this.startedAt),
            limits: request.limits,
            fingerprintChanged: null,
            nextAction: 'wait',
        };
    }

    getStatus(): AutonomousQualityGateStatusV1 {
        return structuredClone(this.status);
    }

    snapshot(): AutonomousQualityGateRuntimeSnapshot {
        return {
            status: this.getStatus(),
            startedAt: this.startedAt,
            inputEpoch: this.admission.inputEpoch,
            ...(this.previousFailure ? { previousFailure: structuredClone(this.previousFailure) } : {}),
        };
    }

    setSessionIdle(idle: boolean): void {
        this.admission.setSessionIdle(idle);
    }

    noteUserInput(): void {
        this.admission.noteUserInput();
    }

    control(
        action: 'pause' | 'resume' | 'stop',
        expectedRevision: number,
    ): { accepted: boolean; conflict?: boolean; status: AutonomousQualityGateStatusV1 } {
        if (action === 'stop') {
            this.admission.cancelActiveOperation();
            if (this.status.stage !== 'stopped') this.update({ stage: 'stopped', nextAction: 'none' });
            return { accepted: true, status: this.getStatus() };
        }
        if (action === 'pause') {
            if (isTerminal(this.status.stage)) return { accepted: false, status: this.getStatus() };
            if (this.status.stage !== 'paused') {
                this.pausedFrom = this.status.stage;
                this.admission.cancelActiveOperation();
                this.update({ stage: 'paused', nextAction: 'resume' });
            }
            return { accepted: true, status: this.getStatus() };
        }
        if (this.status.revision !== expectedRevision) {
            return { accepted: false, conflict: true, status: this.getStatus() };
        }
        if (this.status.stage !== 'paused') return { accepted: false, status: this.getStatus() };
        const resumedStage = this.pausedFrom === 'repairing' || this.pausedFrom === 'unchanged-after-failure'
            ? this.pausedFrom
            : 'awaiting-completion';
        this.update({ stage: resumedStage, nextAction: 'wait' });
        return { accepted: true, status: this.getStatus() };
    }

    recordAssistantTurn(providerTokens: { total: number }): void {
        this.status = {
            ...this.status,
            revision: this.status.revision + 1,
            usage: consumeAutonomousQualityGateBudget(this.status.usage, {
                turns: 1,
                providerTokens,
                startedAt: this.startedAt,
                now: this.now(),
            }),
        };
    }

    async onCompletionCandidate(): Promise<AutonomousQualityGateStatusV1> {
        if (isTerminal(this.status.stage) || !this.admission.sessionIdle) return this.getStatus();
        this.refreshElapsed();
        const limitReason = findAutonomousQualityGateLimit(this.status.usage, this.request.limits);
        if (limitReason) {
            this.update({ stage: 'limit-reached', limitReason, nextAction: 'none' });
            return this.getStatus();
        }

        const operation = this.admission.beginGateOperation();
        this.update({ stage: 'verifying', nextAction: 'wait' });
        const outcome = await runAutonomousQualityGateAttempt({
            plan: this.request.plan,
            previousFailure: this.previousFailure,
            maxGateAttempts: this.request.limits.maxGateAttempts,
            capture: this.deps.capture,
            runPhase: phase => this.deps.runPhase(phase, operation.signal),
        });
        operation.finish();

        if (operation.signal.aborted || operation.inputEpoch !== this.admission.inputEpoch) {
            if (this.status.stage === 'paused' || this.status.stage === 'stopped') return this.getStatus();
            this.update({ stage: 'awaiting-completion', nextAction: 'wait' });
            return this.getStatus();
        }
        if (outcome.status === 'stale') {
            this.update({
                stage: 'awaiting-completion',
                attempt: outcome.attempt,
                fingerprintChanged: true,
                nextAction: 'wait',
            });
            return this.getStatus();
        }
        if (outcome.status === 'passed') {
            const fingerprintChanged = this.fingerprintChanged(outcome.fingerprint);
            this.previousFailure = undefined;
            this.update({
                stage: 'passed',
                attempt: outcome.attempt,
                fingerprintChanged,
                lastPhase: publicPhaseResult(outcome.result),
                nextAction: 'review',
            });
            return this.getStatus();
        }

        const failureResult = outcome.status === 'failed' ? outcome.result : outcome.previousResult;
        const fingerprint = outcome.fingerprint;
        this.previousFailure = { attempt: outcome.attempt, fingerprint, result: failureResult };
        if (outcome.status === 'retry-exhausted') {
            this.update({
                stage: 'limit-reached',
                attempt: outcome.attempt,
                fingerprintChanged: this.fingerprintChanged(fingerprint),
                lastPhase: publicPhaseResult(failureResult),
                limitReason: 'max-gate-attempts',
                nextAction: 'none',
            });
            return this.getStatus();
        }

        const phase = this.request.plan.phases.find(candidate => candidate.name === failureResult.name);
        const artifact = buildAutonomousGateFailureArtifact({
            attempt: outcome.attempt,
            maxGateAttempts: this.request.limits.maxGateAttempts,
            command: phase?.command ?? 'unknown',
            fingerprint,
            result: failureResult,
        });
        const admitted = await this.admission.admitRepair(operation.inputEpoch, () => (
            this.deps.sendRepair(serializeAutonomousGateFailureContinuation(artifact))
        ));
        if (!admitted) {
            this.update({ stage: 'awaiting-completion', nextAction: 'wait' });
            return this.getStatus();
        }

        this.status = {
            ...this.status,
            revision: this.status.revision + 1,
            stage: outcome.status === 'failed' ? 'repairing' : 'unchanged-after-failure',
            attempt: outcome.attempt,
            usage: consumeAutonomousQualityGateBudget(this.status.usage, {
                continuations: 1,
                startedAt: this.startedAt,
                now: this.now(),
            }),
            fingerprintChanged: this.fingerprintChanged(fingerprint),
            lastPhase: publicPhaseResult(failureResult),
            nextAction: 'wait',
        };
        return this.getStatus();
    }

    private refreshElapsed(): void {
        this.status = {
            ...this.status,
            usage: consumeAutonomousQualityGateBudget(this.status.usage, {
                startedAt: this.startedAt,
                now: this.now(),
            }),
        };
    }

    private fingerprintChanged(fingerprint: string): boolean | null {
        return this.previousFailure ? this.previousFailure.fingerprint !== fingerprint : null;
    }

    private update(patch: Partial<AutonomousQualityGateStatusV1>): void {
        this.status = { ...this.status, ...patch, revision: this.status.revision + 1 };
    }
}

function publicPhaseResult(
    result: AutonomousQualityGatePhaseResult,
): NonNullable<AutonomousQualityGateStatusV1['lastPhase']> {
    return {
        name: result.name,
        status: result.status,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
    };
}

function isTerminal(stage: AutonomousQualityGateStatusV1['stage']): boolean {
    return stage === 'passed' || stage === 'stopped' || stage === 'limit-reached';
}
