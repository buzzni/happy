import { describe, expect, it } from 'vitest';
import { ClaudeTurnUsageTracker } from './claudeTurnUsage';

const resultUsage = { input_tokens: 962, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe('ClaudeTurnUsageTracker', () => {
    // Z.AI 호환 엔드포인트 경로에서 Claude Code 의 assistant 메시지 usage 는 0 으로 오고
    // 실제 토큰은 턴 종료 result 메시지에만 있다 (2026-09-05 prod 실측).
    it('falls back to the result usage when every assistant message in the turn reported zero tokens', () => {
        const tracker = new ClaudeTurnUsageTracker();
        tracker.noteAssistant({ usage: { input_tokens: 0, output_tokens: 0 }, model: 'glm-5.3-flash' });

        expect(tracker.resolveResult({
            usage: resultUsage,
            modelUsage: { 'glm-4.7': { inputTokens: 962, outputTokens: 3 } },
        })).toEqual({ usage: resultUsage, model: 'glm-4.7' });
    });

    it('does not double count when assistant messages already carried tokens', () => {
        const tracker = new ClaudeTurnUsageTracker();
        tracker.noteAssistant({ usage: { input_tokens: 100, output_tokens: 20 }, model: 'claude-sonnet-4-5' });

        expect(tracker.resolveResult({ usage: resultUsage, modelUsage: {} })).toBeNull();
    });

    it('ignores a result without tokens and resets for the next turn', () => {
        const tracker = new ClaudeTurnUsageTracker();
        tracker.noteAssistant({ usage: { input_tokens: 0, output_tokens: 0 }, model: 'glm-5.3-flash' });

        expect(tracker.resolveResult({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull();
        // 다음 턴은 새로 센다.
        expect(tracker.resolveResult({ usage: resultUsage })).toEqual({ usage: resultUsage, model: null });
    });

    it('prefers the assistant model when modelUsage is absent and picks the busiest model otherwise', () => {
        const tracker = new ClaudeTurnUsageTracker();
        tracker.noteAssistant({ usage: { input_tokens: 0, output_tokens: 0 }, model: 'glm-5.3-flash' });
        expect(tracker.resolveResult({ usage: resultUsage })?.model).toBe('glm-5.3-flash');

        tracker.noteAssistant({ usage: { input_tokens: 0, output_tokens: 0 }, model: 'glm-5.3-flash' });
        expect(tracker.resolveResult({
            usage: resultUsage,
            modelUsage: { 'glm-4.7': { inputTokens: 10, outputTokens: 1 }, 'glm-5.3': { inputTokens: 900, outputTokens: 2 } },
        })?.model).toBe('glm-5.3');
    });
});
