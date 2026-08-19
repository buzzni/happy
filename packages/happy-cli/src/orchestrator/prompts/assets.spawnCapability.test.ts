import { describe, expect, it } from 'vitest';
import { BASE_PROMPT } from './assets';

// specs/cli-agent-spawn-context-files R6 (aplus-dev-studio-desktop).
//
// A user asked their session "start a new conversation with this context" and was told it was
// impossible — the assistant said session creation only happens in the app or a terminal. That
// was wrong: every Saycode-started session gets SAYCODE_AGENT_ENV=1, so `saycode agent spawn`
// was available the whole time. Nothing in the prompt mentioned it, so the model concluded the
// capability did not exist.
//
// The capability is useless while it stays invisible, which makes this prompt line part of the
// feature rather than documentation about it.
describe('BASE_PROMPT — sibling session capability', () => {
    it('tells the assistant it can start a new conversation itself', () => {
        expect(BASE_PROMPT).toContain('saycode agent spawn');
    });

    it('shows how to hand the new conversation its context', () => {
        // Without --file the assistant falls back to inlining a whole document into the prompt,
        // which is exactly the workaround this capability exists to replace.
        expect(BASE_PROMPT).toContain('--file');
    });

    it('names the check that tells the assistant whether spawning is available right now', () => {
        // Depth and budget limits mean "can spawn" is not a constant. An assistant that assumes
        // either answer is wrong half the time; `agent whoami` is what makes it checkable.
        expect(BASE_PROMPT).toContain('saycode agent whoami');
    });
});
