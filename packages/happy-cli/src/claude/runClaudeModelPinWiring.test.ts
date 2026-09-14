import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// runClaude's message loop cannot be unit tested (it owns a live session, an SDK
// child process and a socket), so the pin wiring is pinned here at the source
// level. The behaviour itself is covered by src/utils/sessionModelPin.test.ts.
const source = readFileSync(new URL('./runClaude.ts', import.meta.url), 'utf8');

describe('runClaude session model pin wiring', () => {
    // Publishing the runtime-substituted model leaks a Z.AI-only rewrite to every
    // other device: a pinned Fable normalizes to undefined (which clears the pin)
    // and a pinned Sonnet 4.6 normalizes to 'sonnet', which the apps resolve back
    // to Sonnet 5 — the user's selection silently changes model.
    it('publishes the model the user asked for, not the runtime substitution', () => {
        expect(source).toContain('model: message.meta?.model || undefined,');
        expect(source).not.toContain('model: messageModel,\n            specifiesEffort');
    });

    it('seeds the spawn pin from the requested model rather than the normalized one', () => {
        expect(source).toContain('...(requestedInitialModel ? { model: requestedInitialModel } : {}),');
    });

    // The seed that actually runs still goes through the runtime normalization.
    it('still normalizes the model it hands to the SDK', () => {
        expect(source).toContain('normalizeClaudeModelForRuntime(requestedInitialModel, process.env)');
    });

    // A spawn that named no model is the real Default path (the web UI omits
    // meta.model for a Default selection and its spawn RPC carries no model at
    // all). A bare DEFAULT_CLAUDE_MODEL here resolves to glm-5.3 on Z.AI —
    // ~18x the input price of the flash model the product defaults to.
    it('routes the no-model fallback through the runtime default', () => {
        expect(source).toContain(
            'explicitInitialModel ?? defaultClaudeModelForRuntime(process.env, DEFAULT_CLAUDE_MODEL)',
        );
        expect(source).not.toContain('explicitInitialModel ?? DEFAULT_CLAUDE_MODEL');
    });

    // happy-app sends meta.model = null for a Default selection
    // (sources/sync/messageMeta.ts), which normalizes to undefined. Left that
    // way on Z.AI the SDK falls to its own sonnet tier = glm-4.7, so the same
    // Default that seeds flash would switch models on the first mobile turn.
    it('applies the runtime default to a cleared model, but never to the fallback model', () => {
        expect(source).toContain(
            'messageModel = defaultClaudeModelForRuntime(process.env, messageModel)',
        );
        expect(source).not.toContain(
            'messageFallbackModel = defaultClaudeModelForRuntime(',
        );
    });
});
