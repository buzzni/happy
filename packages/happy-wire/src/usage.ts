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
} as const;

export const ProviderUsageEventV1Schema = z.object(providerUsageEventShape).strict();

export const AiUsageEventV1Schema = z.object({
    ...providerUsageEventShape,
    happyAccountId: z.string().trim().min(1).max(256),
}).strict();

export type UsageTokenBreakdownV1 = z.infer<typeof UsageTokenBreakdownV1Schema>;
export type UsageCostV1 = z.infer<typeof UsageCostV1Schema>;
export type ProviderUsageEventV1 = z.infer<typeof ProviderUsageEventV1Schema>;
export type AiUsageEventV1 = z.infer<typeof AiUsageEventV1Schema>;
