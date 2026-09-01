import type { AutonomousQualityGateStartRequestV1 } from '../api/autonomousQualityGateProtocol';

export type AutonomousLimitReason =
    | 'max-continuations'
    | 'max-turns'
    | 'max-tokens'
    | 'timeout';

export type AutonomousQualityGateLimits = AutonomousQualityGateStartRequestV1['limits'];

export interface AutonomousQualityGateBudgetUsage {
    continuations: number;
    turns: number;
    tokens: number;
    elapsedMs: number;
}

export const DEFAULT_AUTONOMOUS_QUALITY_GATE_LIMITS: AutonomousQualityGateLimits = {
    maxContinuations: 3,
    maxTurns: 12,
    maxTokens: 80_000,
    timeoutMs: 30 * 60_000,
    maxGateAttempts: 3,
};

const LIMIT_BOUNDS: Record<keyof AutonomousQualityGateLimits, readonly [number, number]> = {
    maxContinuations: [1, 20],
    maxTurns: [1, 100],
    maxTokens: [1, 10_000_000],
    timeoutMs: [1_000, 86_400_000],
    maxGateAttempts: [1, 10],
};

export function normalizeAutonomousQualityGateLimits(
    input: Partial<AutonomousQualityGateLimits> | undefined,
): AutonomousQualityGateLimits {
    return {
        maxContinuations: normalizeLimit(input?.maxContinuations, 'maxContinuations'),
        maxTurns: normalizeLimit(input?.maxTurns, 'maxTurns'),
        maxTokens: normalizeLimit(input?.maxTokens, 'maxTokens'),
        timeoutMs: normalizeLimit(input?.timeoutMs, 'timeoutMs'),
        maxGateAttempts: normalizeLimit(input?.maxGateAttempts, 'maxGateAttempts'),
    };
}

export function createAutonomousQualityGateBudgetUsage(
    startedAt: number,
    now = startedAt,
): AutonomousQualityGateBudgetUsage {
    return {
        continuations: 0,
        turns: 0,
        tokens: 0,
        elapsedMs: elapsedSince(startedAt, now),
    };
}

export function consumeAutonomousQualityGateBudget(
    usage: AutonomousQualityGateBudgetUsage,
    event: {
        continuations?: number;
        turns?: number;
        providerTokens?: { total: number };
        startedAt: number;
        now: number;
    },
): AutonomousQualityGateBudgetUsage {
    return {
        continuations: safeAdd(usage.continuations, event.continuations),
        turns: safeAdd(usage.turns, event.turns),
        tokens: safeAdd(usage.tokens, event.providerTokens?.total),
        elapsedMs: Math.max(usage.elapsedMs, elapsedSince(event.startedAt, event.now)),
    };
}

export function findAutonomousQualityGateLimit(
    usage: AutonomousQualityGateBudgetUsage,
    limits: AutonomousQualityGateLimits,
): AutonomousLimitReason | undefined {
    if (usage.continuations >= limits.maxContinuations) return 'max-continuations';
    if (usage.turns >= limits.maxTurns) return 'max-turns';
    if (usage.tokens >= limits.maxTokens) return 'max-tokens';
    if (usage.elapsedMs >= limits.timeoutMs) return 'timeout';
    return undefined;
}

function normalizeLimit(
    value: number | undefined,
    name: keyof AutonomousQualityGateLimits,
): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_AUTONOMOUS_QUALITY_GATE_LIMITS[name];
    }
    const [minimum, maximum] = LIMIT_BOUNDS[name];
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function safeAdd(current: number, increment: number | undefined): number {
    const delta = increment === undefined || !Number.isFinite(increment)
        ? 0
        : Math.max(0, Math.trunc(increment));
    return Math.min(Number.MAX_SAFE_INTEGER, current + delta);
}

function elapsedSince(startedAt: number, now: number): number {
    if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
    return Math.max(0, Math.trunc(now - startedAt));
}
