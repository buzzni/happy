import { z } from 'zod';

export const AUTONOMOUS_QUALITY_GATE_SCHEMA_VERSION = 1 as const;
export const MAX_AUTONOMOUS_GATE_COMMAND_LENGTH = 8_192;

const BoundedIdSchema = z.string().min(1).max(128);
const PhaseNameSchema = z.enum(['bootstrap', 'build', 'test', 'start']);
const LimitsSchema = z.object({
    maxContinuations: z.number().int().min(1).max(20),
    maxTurns: z.number().int().min(1).max(100),
    maxTokens: z.number().int().min(1).max(10_000_000),
    timeoutMs: z.number().int().min(1_000).max(86_400_000),
    maxGateAttempts: z.number().int().min(1).max(10),
});

export const AutonomousQualityGateCapabilityAdvertisementSchema = z.object({
    apiVersion: z.number().int().min(1),
    rpcAvailable: z.boolean(),
});

export const AutonomousQualityGateCapabilityV1Schema = z.object({
    apiVersion: z.literal(AUTONOMOUS_QUALITY_GATE_SCHEMA_VERSION),
    rpcAvailable: z.boolean(),
});

const VerifyPhasePlanV1Schema = z.object({
    name: PhaseNameSchema,
    command: z.string().min(1).max(MAX_AUTONOMOUS_GATE_COMMAND_LENGTH),
    timeoutMs: z.number().int().min(1_000).max(30 * 60_000),
    readinessUrl: z.string().min(1).max(2_048).optional(),
});

const VerifyPlanV1Schema = z.object({
    phases: z.array(VerifyPhasePlanV1Schema).min(1).max(4),
}).superRefine((plan, context) => {
    const names = plan.phases.map(phase => phase.name);
    if (new Set(names).size !== names.length) {
        context.addIssue({ code: 'custom', message: 'verify phase names must be unique' });
    }
});

export const AutonomousQualityGateStartRequestV1Schema = z.object({
    schemaVersion: z.literal(AUTONOMOUS_QUALITY_GATE_SCHEMA_VERSION),
    requestId: BoundedIdSchema,
    sessionId: BoundedIdSchema,
    projectId: BoundedIdSchema,
    directory: z.string().min(1).max(4_096),
    recipeRevision: z.string().regex(/^[a-f0-9]{64}$/),
    plan: VerifyPlanV1Schema,
    limits: LimitsSchema,
});

export const AutonomousQualityGateStatusRequestV1Schema = z.object({
    schemaVersion: z.literal(AUTONOMOUS_QUALITY_GATE_SCHEMA_VERSION),
    sessionId: BoundedIdSchema,
});

export const AutonomousQualityGateControlRequestV1Schema = z.object({
    schemaVersion: z.literal(AUTONOMOUS_QUALITY_GATE_SCHEMA_VERSION),
    requestId: BoundedIdSchema,
    runId: BoundedIdSchema,
    expectedRevision: z.number().int().min(0),
    action: z.enum(['pause', 'resume', 'stop']),
});

export const AutonomousQualityGateStatusV1Schema = z.object({
    schemaVersion: z.literal(AUTONOMOUS_QUALITY_GATE_SCHEMA_VERSION),
    runId: BoundedIdSchema,
    revision: z.number().int().min(0),
    sessionId: BoundedIdSchema,
    projectId: BoundedIdSchema,
    stage: z.enum([
        'awaiting-completion',
        'verifying',
        'repairing',
        'unchanged-after-failure',
        'passed',
        'paused',
        'stopped',
        'blocked',
        'limit-reached',
    ]),
    attempt: z.number().int().min(0),
    usage: z.object({
        continuations: z.number().int().min(0),
        turns: z.number().int().min(0),
        tokens: z.number().int().min(0),
        elapsedMs: z.number().int().min(0),
    }),
    limits: LimitsSchema,
    lastPhase: z.object({
        name: PhaseNameSchema,
        status: z.enum(['passed', 'failed', 'timed-out', 'aborted']),
        exitCode: z.number().int().nullable(),
        timedOut: z.boolean(),
        outputTruncated: z.boolean(),
    }).nullable().optional(),
    fingerprintChanged: z.boolean().nullable(),
    limitReason: z.enum(['max-continuations', 'max-turns', 'max-tokens', 'timeout', 'max-gate-attempts']).optional(),
    nextAction: z.enum(['wait', 'verify', 'repair', 'resume', 'stop', 'review', 'none']),
});

export type AutonomousQualityGateCapabilityAdvertisement = z.infer<typeof AutonomousQualityGateCapabilityAdvertisementSchema>;
export type AutonomousQualityGateCapabilityV1 = z.infer<typeof AutonomousQualityGateCapabilityV1Schema>;
export type AutonomousQualityGateStartRequestV1 = z.infer<typeof AutonomousQualityGateStartRequestV1Schema>;
export type AutonomousQualityGateStatusRequestV1 = z.infer<typeof AutonomousQualityGateStatusRequestV1Schema>;
export type AutonomousQualityGateControlRequestV1 = z.infer<typeof AutonomousQualityGateControlRequestV1Schema>;
export type AutonomousQualityGateStatusV1 = z.infer<typeof AutonomousQualityGateStatusV1Schema>;
