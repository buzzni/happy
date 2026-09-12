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

/**
 * 턴 종료 result 기준 보정 이벤트 (src/usage/claudeTurnUsage.ts 참조). id 는 result uuid 로
 * 만들어 assistant 메시지 이벤트와 절대 겹치지 않고, 같은 result 가 두 번 전달돼도 idempotent 하다.
 */
export function createClaudeTurnUsageEvent(input: {
    sessionId: string;
    occurredAt: number;
    resultUuid: string;
    model?: string | null;
    usage: ClaudeUsage;
}): ProviderUsageEventV1 {
    return createClaudeUsageEvent({
        sessionId: input.sessionId,
        occurredAt: input.occurredAt,
        messageId: `turn:${input.resultUuid.trim()}`,
        transcriptUuid: input.resultUuid,
        model: input.model,
        usage: input.usage,
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
