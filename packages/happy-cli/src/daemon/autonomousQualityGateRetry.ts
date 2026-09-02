import type { AutonomousQualityGateStartRequestV1 } from '../api/autonomousQualityGateProtocol';
import type { AutonomousWorktreeFingerprint } from './autonomousQualityGateFingerprint';
import type { AutonomousQualityGatePhaseResult } from './autonomousQualityGateRunner';

type VerifyPlan = AutonomousQualityGateStartRequestV1['plan'];

export interface AutonomousPreviousGateFailure {
    attempt: number;
    fingerprint: string;
    result: AutonomousQualityGatePhaseResult;
}

export type AutonomousQualityGateAttemptResult =
    | { status: 'passed'; attempt: number; fingerprint: string; result: AutonomousQualityGatePhaseResult }
    | { status: 'failed'; attempt: number; fingerprint: string; result: AutonomousQualityGatePhaseResult }
    | { status: 'unchanged-after-failure'; attempt: number; fingerprint: string; previousResult: AutonomousQualityGatePhaseResult }
    | { status: 'retry-exhausted'; attempt: number; fingerprint: string; previousResult: AutonomousQualityGatePhaseResult }
    | { status: 'stale'; attempt: number; before: string; after: string };

export async function runAutonomousQualityGateAttempt(options: {
    plan: VerifyPlan;
    previousFailure?: AutonomousPreviousGateFailure;
    maxGateAttempts: number;
    capture: () => Promise<AutonomousWorktreeFingerprint>;
    runPhase: (phase: VerifyPlan['phases'][number]) => Promise<AutonomousQualityGatePhaseResult>;
}): Promise<AutonomousQualityGateAttemptResult> {
    const before = await options.capture();
    const previous = options.previousFailure;
    if (previous && previous.attempt >= options.maxGateAttempts) {
        return {
            status: 'retry-exhausted',
            attempt: previous.attempt,
            fingerprint: before.digest,
            previousResult: previous.result,
        };
    }

    const attempt = (previous?.attempt ?? 0) + 1;
    if (previous?.fingerprint === before.digest) {
        return {
            status: attempt >= options.maxGateAttempts ? 'retry-exhausted' : 'unchanged-after-failure',
            attempt,
            fingerprint: before.digest,
            previousResult: previous.result,
        };
    }

    let lastResult: AutonomousQualityGatePhaseResult | undefined;
    for (const phase of options.plan.phases) {
        lastResult = await options.runPhase(phase);
        if (lastResult.status !== 'passed') break;
    }
    if (!lastResult) throw new Error('autonomous quality gate plan has no phases');

    const after = await options.capture();
    if (before.digest !== after.digest) {
        return { status: 'stale', attempt, before: before.digest, after: after.digest };
    }
    if (lastResult.status === 'passed') {
        return { status: 'passed', attempt, fingerprint: after.digest, result: lastResult };
    }
    if (attempt >= options.maxGateAttempts) {
        return {
            status: 'retry-exhausted',
            attempt,
            fingerprint: after.digest,
            previousResult: lastResult,
        };
    }
    return { status: 'failed', attempt, fingerprint: after.digest, result: lastResult };
}
