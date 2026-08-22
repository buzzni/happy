import { describe, expect, it, vi } from 'vitest';

vi.mock('./claudeSettings', () => ({
    shouldIncludeCoAuthoredBy: () => false
}));

import { CHAT_TITLE_SYSTEM_PROMPT } from './systemPrompt';

describe('CHAT_TITLE_SYSTEM_PROMPT', () => {
    // This is the always-on injection point for the title instruction — the
    // per-turn nudge in titlePrompt.ts is skipped for empty user turns, so
    // dropping branchSlug here silently disables branch naming.
    it('asks for both a title and an English branchSlug', () => {
        expect(CHAT_TITLE_SYSTEM_PROMPT).toContain('mcp__happy__change_title');
        expect(CHAT_TITLE_SYSTEM_PROMPT).toContain('branchSlug');
        expect(CHAT_TITLE_SYSTEM_PROMPT).toContain('kebab-case');
    });
});
