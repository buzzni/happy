import { describe, expect, it, vi } from 'vitest';

vi.mock('./claudeSettings', () => ({
    shouldIncludeCoAuthoredBy: () => false
}));

import { systemPrompt } from './systemPrompt';

describe('systemPrompt', () => {
    // This is the always-on injection point for the title instruction — the
    // per-turn nudge in titlePrompt.ts is skipped for empty user turns, so
    // dropping branchSlug here silently disables branch naming.
    it('asks for both a title and an English branchSlug', () => {
        expect(systemPrompt).toContain('mcp__happy__change_title');
        expect(systemPrompt).toContain('branchSlug');
        expect(systemPrompt).toContain('kebab-case');
    });
});
