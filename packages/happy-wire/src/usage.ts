import { z } from 'zod';

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const UsageTokenBreakdownV1Schema = z.object({
    input: nonNegativeSafeInteger,
    output: nonNegativeSafeInteger,
    cacheRead: nonNegativeSafeInteger,
    cacheWrite: nonNegativeSafeInteger,
    reasoning: nonNegativeSafeInteger,
    total: nonNegativeSafeInteger,
}).strict().superRefine((tokens, ctx) => {
    const bucketTotal = tokens.input
        + tokens.output
        + tokens.cacheRead
        + tokens.cacheWrite
        + tokens.reasoning;
    if (bucketTotal !== tokens.total) {
        ctx.addIssue({
            code: 'custom',
            path: ['total'],
            message: 'total must equal the sum of exclusive token buckets',
        });
    }
});

export const UsageCostV1Schema = z.object({
    amountMicros: nonNegativeSafeInteger,
    currency: z.literal('USD'),
    kind: z.enum(['provider', 'estimated']),
    pricingVersion: z.string().trim().min(1).max(128).nullable(),
}).strict();

/**
 * Which credential the run that produced this usage was actually spent on.
 *
 * `appliedSource` is a loose string on purpose. The closed set of tokens lives
 * on the receiving side (the ledger downgrades anything it does not know to
 * `unknown`); a closed enum here would mean a newer CLI reporting a source
 * this schema predates loses the whole event, tokens and cost included. The
 * value is permissive, the type is not: a number is still a refusal.
 *
 * Additive and optional, so `schemaVersion` stays at 1 — a CLI that does not
 * report a source keeps parsing unchanged.
 *
 * Mirrors `packages/web-ui/server/aiUsageContract.ts` in aplus-dev-studio.
 */
export const AiAuthReportV1Schema = z.object({
    appliedSource: z.string().trim().max(64).nullish(),
    // 상한은 수신 측 저장 컬럼(PostgreSQL INTEGER)에 맞춘다. 더 넓으면 부가
    // metadata 하나 때문에 그 이벤트의 토큰 사용량까지 통째로 잃는다.
    connectionVersion: nonNegativeSafeInteger.max(2_147_483_647).nullish(),
}).strict();

/**
 * One rate-limit window as the agent CLI already knew it when the usage was spent
 * (aplus specs/org-member-ai-plan-usage P10): percent used (0-100) and the reset
 * time in epoch ms. Loose on purpose and unknown keys are stripped — the ledger
 * clamps the values, so a limit reading never costs the event its tokens.
 */
export const UsageRateLimitWindowV1Schema = z.object({
    usedPercent: z.number(),
    resetsAt: z.number().nullable(),
});

const providerUsageEventShape = {
    source: z.literal('happy-cli'),
    sourceEventId: z.string().trim().min(1).max(512),
    schemaVersion: z.literal(1),
    occurredAt: nonNegativeSafeInteger,
    sessionId: z.string().trim().min(1).max(256),
    provider: z.enum(['anthropic', 'openai', 'google', 'xai', 'other']),
    agent: z.enum(['claude', 'codex', 'gemini', 'grok', 'openclaw', 'opencode', 'other']),
    model: z.string().trim().min(1).max(256).nullable(),
    measurement: z.literal('delta'),
    tokens: UsageTokenBreakdownV1Schema,
    cost: UsageCostV1Schema.nullable(),
    quality: z.enum(['exact', 'estimated']),
    aiAuth: AiAuthReportV1Schema.nullish(),
    /**
     * The plan tier of the login the run spent (`claude:max_20x`, `chatgpt:plus`),
     * as the official CLI reported it. Loose on purpose, like `appliedSource`: the
     * ledger validates the `<family>:<tier>` shape and downgrades anything else to
     * NULL, so a tier this schema predates never costs the event its tokens.
     *
     * Additive and optional (`schemaVersion` stays 1). Mirrors `planTier` in
     * `packages/web-ui/server/aiUsageContract.ts` in aplus-dev-studio, which must
     * accept it **before** a CLI sends it — the receivers are strict.
     */
    planTier: z.string().trim().max(64).nullish(),
    /** The run account's five-hour and weekly windows at that moment. Mirrors `rateLimits` in aiUsageContract.ts. */
    rateLimits: z.object({
        fiveHour: UsageRateLimitWindowV1Schema.nullish(),
        weekly: UsageRateLimitWindowV1Schema.nullish(),
    }).nullish(),
} as const;

export const ProviderUsageEventV1Schema = z.object(providerUsageEventShape).strict();

export const AiUsageEventV1Schema = z.object({
    ...providerUsageEventShape,
    happyAccountId: z.string().trim().min(1).max(256),
}).strict();

export type UsageTokenBreakdownV1 = z.infer<typeof UsageTokenBreakdownV1Schema>;
export type UsageCostV1 = z.infer<typeof UsageCostV1Schema>;
export type AiAuthReportV1 = z.infer<typeof AiAuthReportV1Schema>;
export type UsageRateLimitWindowV1 = z.infer<typeof UsageRateLimitWindowV1Schema>;
export type UsageRateLimitsV1 = NonNullable<ProviderUsageEventV1['rateLimits']>;
export type ProviderUsageEventV1 = z.infer<typeof ProviderUsageEventV1Schema>;
export type AiUsageEventV1 = z.infer<typeof AiUsageEventV1Schema>;
