import {
    ProviderUsageEventV1Schema,
    type ProviderUsageEventV1,
} from '@slopus/happy-wire';

type ClaudeUsage = {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
};

type CodexUsage = {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
};

function normalizedModel(model: string | null | undefined): string | null {
    const value = model?.trim();
    return value ? value : null;
}

export function createClaudeUsageEvent(input: {
    sessionId: string;
    occurredAt: number;
    messageId?: string | null;
    transcriptUuid: string;
    model?: string | null;
    usage: ClaudeUsage;
}): ProviderUsageEventV1 {
    const providerEventId = input.messageId?.trim() || input.transcriptUuid.trim();
    const cacheRead = input.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = input.usage.cache_creation_input_tokens ?? 0;
    const total = input.usage.input_tokens + input.usage.output_tokens + cacheRead + cacheWrite;

    return ProviderUsageEventV1Schema.parse({
        source: 'happy-cli',
        sourceEventId: `${input.sessionId}:anthropic:${providerEventId}`,
        schemaVersion: 1,
        occurredAt: input.occurredAt,
        sessionId: input.sessionId,
        provider: 'anthropic',
        agent: 'claude',
        model: normalizedModel(input.model),
        measurement: 'delta',
        tokens: {
            input: input.usage.input_tokens,
            output: input.usage.output_tokens,
            cacheRead,
            cacheWrite,
            reasoning: 0,
            total,
        },
        cost: null,
        quality: 'exact',
    });
}

export function createCodexUsageEvent(input: {
    sessionId: string;
    responseId: string;
    occurredAt: number;
    model?: string | null;
    usage: CodexUsage;
}): ProviderUsageEventV1 {
    const exclusiveInput = input.usage.inputTokens
        - input.usage.cachedInputTokens
        - input.usage.cacheWriteInputTokens;
    const exclusiveOutput = input.usage.outputTokens - input.usage.reasoningOutputTokens;

    return ProviderUsageEventV1Schema.parse({
        source: 'happy-cli',
        sourceEventId: `${input.sessionId}:openai:${input.responseId.trim()}`,
        schemaVersion: 1,
        occurredAt: input.occurredAt,
        sessionId: input.sessionId,
        provider: 'openai',
        agent: 'codex',
        model: normalizedModel(input.model),
        measurement: 'delta',
        tokens: {
            input: exclusiveInput,
            output: exclusiveOutput,
            cacheRead: input.usage.cachedInputTokens,
            cacheWrite: input.usage.cacheWriteInputTokens,
            reasoning: input.usage.reasoningOutputTokens,
            total: input.usage.totalTokens,
        },
        cost: null,
        quality: 'exact',
    });
}
