import { describe, expect, it } from 'vitest';

import { shouldHandleCodexClear } from './codexClearCommand';

/**
 * The consumer-side gate (Saycode specs/desktop-messenger-channels — R1/R5).
 *
 * A channel turn never passes the enqueue-side parser, so this is the only place left that can
 * refuse to read relayed text as session control. `/clear` here wipes the Codex thread state —
 * an external sender must not be able to reach it, and the daemon advertises `codex`, so this
 * engine is reachable from a channel today.
 */
describe('shouldHandleCodexClear', () => {
    it('handles a local /clear', () => {
        expect(shouldHandleCodexClear({ message: '/clear' })).toBe(true);
    });

    it('refuses a channel /clear — the reset an external sender must not reach', () => {
        expect(shouldHandleCodexClear({ message: '/clear', requestIds: ['req-1'] })).toBe(false);
    });

    it('leaves ordinary channel text alone either way', () => {
        expect(shouldHandleCodexClear({ message: 'what changed today?', requestIds: ['req-1'] })).toBe(false);
        expect(shouldHandleCodexClear({ message: 'what changed today?' })).toBe(false);
    });

    /**
     * An empty array is not "no channel". It arrives from the same field and means the message
     * carries no ids *yet*; reading it as local input would restore the hole for anything that
     * populates `requestIds` after the queue hands the message over.
     */
    it('treats an empty id list as local, matching the queue contract', () => {
        expect(shouldHandleCodexClear({ message: '/clear', requestIds: [] })).toBe(true);
    });
});
