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
            .toEqual(['axBase', 'coAuthoredCredit', 'optionsGuidance', 'workerDelegation']);
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
