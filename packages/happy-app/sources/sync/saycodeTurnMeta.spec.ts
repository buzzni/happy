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
    it('keeps the legacy shape byte-identical when no overrides exist', () => {
        const meta = buildSaycodeTurnMeta({
            preference: true,
            overrides: {},
            surface: 'mobile',
        });
        expect(meta.saycodeSystemPromptEnabled).toBe(true);
        expect(meta.appendSystemPrompt).toContain('<!-- saycode:owned-prompt -->');
        expect(meta.saycodePromptBlocks).toBeUndefined();
    });

    it('drops only the options guidance when its block is overridden off', () => {
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
        // happy-cli strips every saycode-owned sentinel block from appendSystemPrompt
        // when the master flag is off — wrapping here would let the CLI silently undo
        // the user's explicit override. Under master-off the surviving block must
        // travel unwrapped; under master-on the CLI never strips, so wrapping stays.
        expect(meta.appendSystemPrompt).toContain('# Options');
        expect(meta.appendSystemPrompt).not.toContain('<!-- saycode:owned-prompt -->');
        expect(meta.saycodeSystemPromptEnabled).toBe(false);
    });
});
