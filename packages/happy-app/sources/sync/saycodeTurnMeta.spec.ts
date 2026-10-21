import { describe, expect, it } from 'vitest';
import {
    MOBILE_SAYCODE_PROMPT_BLOCKS,
    buildSaycodeTurnMeta,
} from './saycodeTurnMeta';

describe('MOBILE_SAYCODE_PROMPT_BLOCKS', () => {
    it('never lists the always-on chat title instruction as a toggle', () => {
        expect(MOBILE_SAYCODE_PROMPT_BLOCKS.some((b) => b.id.toLowerCase().includes('title'))).toBe(false);
    });

    it('lists the CLI-wire blocks plus the app-composed options guidance', () => {
        expect(MOBILE_SAYCODE_PROMPT_BLOCKS.map((b) => b.id).sort())
            .toEqual(['agentOrchestration', 'axBase', 'coAuthoredCredit', 'optionsGuidance', 'workerDelegation']);
    });
});

describe('buildSaycodeTurnMeta', () => {
    it('keeps the untouched-account omit behavior when the master leaves the prompt empty', () => {
        // An untouched account must keep omitting (undefined) so non-Saycode context
        // cached by other clients survives — only touched accounts send explicit null.
        const meta = buildSaycodeTurnMeta({
            preference: false,
            overrides: {},
            surface: 'mobile',
        });
        expect(meta.appendSystemPrompt).toBeUndefined();
        expect(meta.saycodePromptBlocks).toEqual({
            agentOrchestration: true,
            workerDelegation: true,
        });
    });

    it('marks app-composed guidance as client-turn scoped when enabled', () => {
        const meta = buildSaycodeTurnMeta({
            preference: true,
            overrides: {},
            surface: 'mobile',
        });
        expect(meta.saycodeSystemPromptEnabled).toBe(true);
        expect(meta.appendSystemPrompt).toMatch(/<!-- saycode:client-turn-prompt:[a-z0-9]+-[a-z0-9]+:start -->/);
        expect(meta.saycodePromptBlocks).toBeUndefined();
    });

    it('omits append when options guidance is off so runtime removes only its cached client-turn block', () => {
        const meta = buildSaycodeTurnMeta({
            preference: true,
            overrides: { optionsGuidance: false },
            surface: 'mobile',
        });
        expect(meta.appendSystemPrompt).toBeUndefined();
        // The app-composed id never travels on the wire — happy-cli does not know it.
        expect(meta.saycodePromptBlocks).toBeUndefined();
        expect(meta.saycodeSystemPromptEnabled).toBe(true);
    });

    it('sends only CLI-wire overrides on the wire', () => {
        const meta = buildSaycodeTurnMeta({
            preference: true,
            overrides: { workerDelegation: false, optionsGuidance: false, retiredBlock: true },
            surface: 'mobile',
        });
        expect(meta.saycodePromptBlocks).toEqual({ workerDelegation: false });
    });

    it('keeps explicit child-agent off without disabling worker delegation', () => {
        const meta = buildSaycodeTurnMeta({
            preference: false,
            overrides: { agentOrchestration: false },
            surface: 'mobile',
        });
        expect(meta.saycodePromptBlocks).toEqual({
            agentOrchestration: false,
            workerDelegation: true,
        });
    });

    it('keeps the options guidance when the master is off but its block is overridden on', () => {
        const meta = buildSaycodeTurnMeta({
            preference: false,
            overrides: { optionsGuidance: true },
            surface: 'mobile',
        });
        expect(meta.appendSystemPrompt).toContain('# Options');
        expect(meta.appendSystemPrompt).toMatch(/<!-- saycode:client-turn-prompt:[a-z0-9]+-[a-z0-9]+:start -->/);
        expect(meta.saycodeSystemPromptEnabled).toBe(false);
    });
});

// Saycode specs/desktop-next-steps-card: `nextSteps` tells happy-cli "this client draws the
// next-steps card". This app draws no such card, so it must never claim to — otherwise the
// agent would put its question where the phone cannot show it. Even an account setting that
// another client wrote under that id must not leak into this app's turns.
describe('next-steps card capability', () => {
    it('never sends nextSteps, even when the account settings hold one', () => {
        for (const preference of [true, false, null]) {
            const meta = buildSaycodeTurnMeta({ preference, overrides: { nextSteps: true }, surface: 'mobile' });
            expect(meta.saycodePromptBlocks?.nextSteps).toBeUndefined();
        }
    });
});
