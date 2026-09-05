import { describe, expect, it } from 'vitest';
import { createClaudeTurnUsageEvent, createClaudeUsageEvent, createCodexUsageEvent } from './providerUsageAdapters';

describe('createClaudeUsageEvent', () => {
    it('uses the native message id so SDK and transcript copies are idempotent', () => {
        const base = {
            sessionId: 'happy-session-1',
            occurredAt: 1_788_000_000_000,
            messageId: 'msg_native_1',
            model: 'claude-sonnet-4-5',
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 40,
                cache_read_input_tokens: 300,
            },
        };

        const sdkEvent = createClaudeUsageEvent({ ...base, transcriptUuid: 'sdk-random-uuid' });
        const transcriptEvent = createClaudeUsageEvent({ ...base, transcriptUuid: 'transcript-uuid' });

        expect(sdkEvent).toEqual(transcriptEvent);
        expect(sdkEvent).toMatchObject({
            sourceEventId: 'happy-session-1:anthropic:msg_native_1',
            provider: 'anthropic',
            agent: 'claude',
            model: 'claude-sonnet-4-5',
            measurement: 'delta',
            tokens: {
                input: 100,
                output: 20,
                cacheRead: 300,
                cacheWrite: 40,
                reasoning: 0,
                total: 460,
            },
        });
    });

    it('falls back to the transcript uuid when the provider message id is absent', () => {
        const event = createClaudeUsageEvent({
            sessionId: 'happy-session-1',
            occurredAt: 1_788_000_000_000,
            transcriptUuid: 'transcript-uuid',
            model: null,
            usage: { input_tokens: 2, output_tokens: 3 },
        });

        expect(event.sourceEventId).toBe('happy-session-1:anthropic:transcript-uuid');
    });
});

describe('createClaudeTurnUsageEvent', () => {
    it('keys the turn fallback on the result uuid so it never collides with message events', () => {
        const event = createClaudeTurnUsageEvent({
            sessionId: 'happy-session-1',
            occurredAt: 1_788_000_000_000,
            resultUuid: 'result-uuid-1',
            model: 'glm-4.7',
            usage: { input_tokens: 962, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        });

        expect(event).toMatchObject({
            sourceEventId: 'happy-session-1:anthropic:turn:result-uuid-1',
            provider: 'anthropic',
            agent: 'claude',
            model: 'glm-4.7',
            measurement: 'delta',
            tokens: { input: 962, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 965 },
        });
    });
});

describe('createCodexUsageEvent', () => {
    it('turns cached and reasoning subsets into exclusive token buckets', () => {
        const event = createCodexUsageEvent({
            sessionId: 'happy-session-2',
            responseId: 'response-1',
            occurredAt: 1_788_000_000_100,
            model: 'gpt-5.5',
            usage: {
                totalTokens: 150,
                inputTokens: 120,
                cachedInputTokens: 70,
                cacheWriteInputTokens: 10,
                outputTokens: 30,
                reasoningOutputTokens: 5,
            },
        });

        expect(event).toMatchObject({
            sourceEventId: 'happy-session-2:openai:response-1',
            provider: 'openai',
            agent: 'codex',
            model: 'gpt-5.5',
            measurement: 'delta',
            tokens: {
                input: 40,
                cacheRead: 70,
                cacheWrite: 10,
                output: 25,
                reasoning: 5,
                total: 150,
            },
        });
    });

    it('rejects an invalid provider total instead of silently changing it', () => {
        expect(() => createCodexUsageEvent({
            sessionId: 'happy-session-2',
            responseId: 'response-2',
            occurredAt: 1_788_000_000_100,
            model: null,
            usage: {
                totalTokens: 999,
                inputTokens: 10,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 5,
                reasoningOutputTokens: 0,
            },
        })).toThrow();
    });
});
