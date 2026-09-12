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
    redactAutonomousGatePhaseResult,
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
    sendRepair: (
        message: string,
        options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<void>;
    onRepairAdmission?: () => void;
    checkpoint?: () => Promise<void>;
    initialSessionUsage?: { turns: number; tokens: number };
    restored?: AutonomousQualityGateRuntimeSnapshot;
}

export interface AutonomousQualityGateRuntimeSnapshot {
    status: AutonomousQualityGateStatusV1;
    startedAt: number;
    inputEpoch: number;
    reportedTurns: number;
    reportedTokens: number;
    pausedFrom?: AutonomousQualityGateStatusV1['stage'];
    previousFailure?: AutonomousPreviousGateFailure;
}

export class AutonomousQualityGateRuntime {
    private readonly admission: AutonomousQualityGateAdmission;
    private readonly startedAt: number;
    private readonly now: () => number;
    private previousFailure?: AutonomousPreviousGateFailure;
    private reportedTurns: number;
    private reportedTokens: number;
    private pausedFrom: AutonomousQualityGateStatusV1['stage'] = 'awaiting-completion';
    private pendingRepairStage?: 'repairing' | 'unchanged-after-failure';
    private status: AutonomousQualityGateStatusV1;

    constructor(
        private readonly request: AutonomousQualityGateStartRequestV1,
        private readonly deps: AutonomousQualityGateRuntimeDependencies,
    ) {
        this.now = deps.now ?? Date.now;
        this.startedAt = deps.restored?.startedAt ?? this.now();
        this.admission = new AutonomousQualityGateAdmission(deps.restored?.inputEpoch);
        this.previousFailure = deps.restored?.previousFailure
            ? {
                ...deps.restored.previousFailure,
                result: redactAutonomousGatePhaseResult(deps.restored.previousFailure.result),
            }
            : undefined;
        this.reportedTurns = deps.restored?.reportedTurns ?? deps.initialSessionUsage?.turns ?? 0;
        this.reportedTokens = deps.restored?.reportedTokens ?? deps.initialSessionUsage?.tokens ?? 0;
        this.pausedFrom = deps.restored?.pausedFrom ?? 'awaiting-completion';
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
        if (deps.restored?.status.stage === 'verifying') {
            this.status = {
                ...this.status,
                revision: this.status.revision + 1,
                stage: 'blocked',
                blockedReason: 'interrupted-operation',
                nextAction: 'none',
            };
        }
    }

    getStatus(): AutonomousQualityGateStatusV1 {
        return structuredClone(this.status);
    }

    snapshot(): AutonomousQualityGateRuntimeSnapshot {
        return {
            status: this.getStatus(),
            startedAt: this.startedAt,
            inputEpoch: this.admission.inputEpoch,
            reportedTurns: this.reportedTurns,
            reportedTokens: this.reportedTokens,
            pausedFrom: this.pausedFrom,
            ...(this.previousFailure ? { previousFailure: structuredClone(this.previousFailure) } : {}),
        };
    }

    setSessionIdle(idle: boolean): void {
        this.admission.setSessionIdle(idle);
    }

    noteUserInput(): void {
        this.admission.noteUserInput();
    }

    isAwaitingRepairTurn(): boolean {
        return isRepairStage(this.status.stage)
            || (this.status.stage === 'paused' && isRepairStage(this.pausedFrom))
            || this.pendingRepairStage !== undefined;
    }

    block(reason: NonNullable<AutonomousQualityGateStatusV1['blockedReason']>): void {
        if (!isTerminal(this.status.stage)) {
            this.admission.cancelActiveOperation();
            this.update({ stage: 'blocked', blockedReason: reason, nextAction: 'none' });
        }
    }

    control(
        action: 'pause' | 'resume' | 'stop',
        expectedRevision: number,
    ): { accepted: boolean; conflict?: boolean; status: AutonomousQualityGateStatusV1 } {
        if (action === 'stop') {
            this.admission.noteUserInput();
            if (this.status.stage !== 'stopped') this.update({ stage: 'stopped', nextAction: 'none' });
            return { accepted: true, status: this.getStatus() };
        }
        if (action === 'pause') {
            if (isTerminal(this.status.stage)) return { accepted: false, status: this.getStatus() };
            this.admission.noteUserInput();
            if (this.status.stage !== 'paused') {
                this.pausedFrom = this.pendingRepairStage ?? this.status.stage;
                this.update({ stage: 'paused', nextAction: 'resume' });
            }
            return { accepted: true, status: this.getStatus() };
        }
        if (this.status.revision !== expectedRevision) {
            return { accepted: false, conflict: true, status: this.getStatus() };
        }
        if (this.status.stage !== 'paused') return { accepted: false, status: this.getStatus() };
        const resumedStage = isRepairStage(this.pausedFrom)
            ? this.pausedFrom
            : 'awaiting-completion';
        this.update({ stage: resumedStage, nextAction: 'wait' });
        return { accepted: true, status: this.getStatus() };
    }

    failClosedAfterResumePersistenceError(): void {
        if (isTerminal(this.status.stage) || this.status.stage === 'paused') return;
        this.admission.noteUserInput();
        this.update({ stage: 'paused', nextAction: 'resume' });
    }

    recordSessionUsage(totals: { turns?: number; tokens?: number }): boolean {
        if (isTerminal(this.status.stage)) return false;
        const turns = totals.turns === undefined ? 0 : cumulativeDelta(this.reportedTurns, totals.turns);
        const tokens = totals.tokens === undefined ? 0 : cumulativeDelta(this.reportedTokens, totals.tokens);
        if (totals.turns !== undefined) this.reportedTurns = totals.turns;
        if (totals.tokens !== undefined) this.reportedTokens = totals.tokens;
        const usage = consumeAutonomousQualityGateBudget(this.status.usage, {
            turns,
            providerTokens: { total: tokens },
            startedAt: this.startedAt,
            now: this.now(),
        });
        const limitReason = findAutonomousQualityGateLimit(usage, this.request.limits);
        const changed = turns > 0 || tokens > 0 || usage.elapsedMs !== this.status.usage.elapsedMs;
        if (!changed && !limitReason) return false;
        if (limitReason) this.admission.cancelActiveOperation();
        this.status = {
            ...this.status,
            revision: this.status.revision + 1,
            usage,
            ...(limitReason ? { stage: 'limit-reached' as const, limitReason, nextAction: 'none' as const } : {}),
        };
        return true;
    }

    expireIfTimedOut(): boolean {
        if (isTerminal(this.status.stage)) return false;
        this.refreshElapsed();
        if (this.status.usage.elapsedMs < this.request.limits.timeoutMs) return false;
        this.admission.cancelActiveOperation();
        this.update({ stage: 'limit-reached', limitReason: 'timeout', nextAction: 'none' });
        return true;
    }

    async onCompletionCandidate(): Promise<AutonomousQualityGateStatusV1> {
        if (!canStartGate(this.status.stage) || !this.admission.sessionIdle) return this.getStatus();
        this.refreshElapsed();
        const limitReason = findAutonomousQualityGateLimit(this.status.usage, this.request.limits);
        if (limitReason) {
            this.update({ stage: 'limit-reached', limitReason, nextAction: 'none' });
            return this.getStatus();
        }

        const operation = this.admission.beginGateOperation();
        this.update({ stage: 'verifying', fingerprintChanged: null, nextAction: 'wait' });
        let outcome: Awaited<ReturnType<typeof runAutonomousQualityGateAttempt>>;
        try {
            await this.deps.checkpoint?.();
            outcome = await runAutonomousQualityGateAttempt({
                plan: this.request.plan,
                previousFailure: this.previousFailure,
                maxGateAttempts: this.request.limits.maxGateAttempts,
                capture: this.deps.capture,
                runPhase: phase => this.deps.runPhase({
                    ...phase,
                    timeoutMs: Math.max(1, Math.min(phase.timeoutMs, this.remainingTimeoutMs())),
                }, operation.signal),
            });
        } catch {
            if (operation.signal.aborted || operation.inputEpoch !== this.admission.inputEpoch) {
                if (!preserveConcurrentControlState(this.status.stage)) {
                    this.update({ stage: 'awaiting-completion', nextAction: 'wait' });
                }
            } else if (!preserveConcurrentControlState(this.status.stage) && !this.expireIfTimedOut()) {
                this.update({ stage: 'blocked', blockedReason: 'runtime-error', nextAction: 'none' });
            }
            return this.getStatus();
        } finally {
            operation.finish();
        }

        if (operation.signal.aborted || operation.inputEpoch !== this.admission.inputEpoch) {
            if (preserveConcurrentControlState(this.status.stage)) return this.getStatus();
            this.update({ stage: 'awaiting-completion', nextAction: 'wait' });
            return this.getStatus();
        }
        if (this.expireIfTimedOut()) return this.getStatus();
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
        const fingerprintChanged = this.fingerprintChanged(fingerprint);
        this.previousFailure = {
            attempt: outcome.attempt,
            fingerprint,
            result: redactAutonomousGatePhaseResult(failureResult),
        };
        if (outcome.status === 'retry-exhausted') {
            this.update({
                stage: 'limit-reached',
                attempt: outcome.attempt,
                fingerprintChanged,
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
        const repairStage = outcome.status === 'failed' ? 'repairing' : 'unchanged-after-failure';
        let admitted: boolean;
        let repairSent = false;
        try {
            admitted = await this.admission.admitRepair(operation.inputEpoch, async (signal) => {
                this.pendingRepairStage = repairStage;
                this.deps.onRepairAdmission?.();
                await this.deps.sendRepair(serializeAutonomousGateFailureContinuation(artifact), {
                    signal,
                    timeoutMs: this.remainingTimeoutMs(),
                });
                repairSent = true;
            });
        } catch {
            if (this.status.stage === 'paused' && this.pendingRepairStage === this.pausedFrom) {
                this.pausedFrom = 'awaiting-completion';
            }
            this.pendingRepairStage = undefined;
            if (preserveConcurrentControlState(this.status.stage)) return this.getStatus();
            if (operation.inputEpoch !== this.admission.inputEpoch) {
                this.update({ stage: 'awaiting-completion', nextAction: 'wait' });
            } else if (!this.expireIfTimedOut()) {
                this.update({ stage: 'blocked', blockedReason: 'repair-delivery-failed', nextAction: 'none' });
            }
            return this.getStatus();
        }
        this.pendingRepairStage = undefined;
        const chargeSentRepair = (): void => {
            if (!repairSent) return;
            repairSent = false;
            this.status = {
                ...this.status,
                revision: this.status.revision + 1,
                usage: consumeAutonomousQualityGateBudget(this.status.usage, {
                    continuations: 1,
                    startedAt: this.startedAt,
                    now: this.now(),
                }),
            };
        };
        if (!admitted) {
            const delivered = repairSent;
            chargeSentRepair();
            if (preserveConcurrentControlState(this.status.stage)
                || (delivered && isRepairStage(this.status.stage))) return this.getStatus();
            this.update({ stage: 'awaiting-completion', nextAction: 'wait' });
            return this.getStatus();
        }
        if (preserveConcurrentControlState(this.status.stage)) {
            chargeSentRepair();
            return this.getStatus();
        }
        if (this.status.usage.elapsedMs >= this.request.limits.timeoutMs || this.remainingTimeoutMs() <= 0) {
            chargeSentRepair();
            this.expireIfTimedOut();
            return this.getStatus();
        }

        this.status = {
            ...this.status,
            revision: this.status.revision + 1,
            stage: repairStage,
            attempt: outcome.attempt,
            usage: consumeAutonomousQualityGateBudget(this.status.usage, {
                continuations: 1,
                startedAt: this.startedAt,
                now: this.now(),
            }),
            fingerprintChanged,
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

    private remainingTimeoutMs(): number {
        return Math.max(0, this.request.limits.timeoutMs - Math.max(
            this.status.usage.elapsedMs,
            Math.max(0, Math.trunc(this.now() - this.startedAt)),
        ));
    }

    private update(patch: Partial<AutonomousQualityGateStatusV1>): void {
        const next = { ...this.status, ...patch, revision: this.status.revision + 1 };
        if (next.stage !== 'blocked') delete next.blockedReason;
        if (next.stage !== 'limit-reached') delete next.limitReason;
        this.status = next;
    }
}

function cumulativeDelta(previous: number, current: number): number {
    return current >= previous ? current - previous : current;
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
    return stage === 'passed' || stage === 'stopped' || stage === 'blocked' || stage === 'limit-reached';
}

function canStartGate(stage: AutonomousQualityGateStatusV1['stage']): boolean {
    return stage === 'awaiting-completion' || stage === 'repairing' || stage === 'unchanged-after-failure';
}

function isRepairStage(
    stage: AutonomousQualityGateStatusV1['stage'],
): stage is 'repairing' | 'unchanged-after-failure' {
    return stage === 'repairing' || stage === 'unchanged-after-failure';
}

function preserveConcurrentControlState(stage: AutonomousQualityGateStatusV1['stage']): boolean {
    return stage === 'paused' || isTerminal(stage);
}
