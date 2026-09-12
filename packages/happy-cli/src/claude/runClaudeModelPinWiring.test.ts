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
});
