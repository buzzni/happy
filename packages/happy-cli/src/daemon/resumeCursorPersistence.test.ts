import { describe, expect, it } from 'vitest';

import {
    RESUME_CURSOR_PERSIST_INTERVAL_MS,
    decideResumeCursorPersist,
} from './resumeCursorPersistence';

// 2026-08-24 finding: on a live prod machine 15 of 86 persisted sessions were
// permanently unresumable. Their records held only the start-time snapshot —
// no `lastProcessedSeq` — because the cursor was written to disk exclusively by
// preserveSessionForResume (clean stop). None of the 15 had ever gone through a
// clean stop; every session that had was resumable. A daemon killed without a
// clean stop therefore strands every session it was running: resume refuses
// with SESSION_CURSOR_MISSING and recovery then refuses too.
describe('decideResumeCursorPersist', () => {
    const now = 1_000_000;

    it('writes the first cursor immediately', () => {
        // The jump from "no cursor" to "any cursor" is what flips a session
        // from unresumable to resumable — it must not wait for the interval.
        expect(decideResumeCursorPersist({
            cursor: 12,
            persistedCursor: undefined,
            lastPersistAt: undefined,
            now,
        })).toBe(true);
    });

    it('skips when the session has not reported a cursor yet', () => {
        expect(decideResumeCursorPersist({
            cursor: undefined,
            persistedCursor: undefined,
            lastPersistAt: undefined,
            now,
        })).toBe(false);
    });

    it('skips a cursor that has not advanced past the persisted one', () => {
        expect(decideResumeCursorPersist({
            cursor: 40,
            persistedCursor: 40,
            lastPersistAt: now - RESUME_CURSOR_PERSIST_INTERVAL_MS * 10,
            now,
        })).toBe(false);
    });

    it('skips a cursor that moved backwards', () => {
        // Reports can arrive out of order; the on-disk baseline must never
        // regress or a resume would replay messages the session already read.
        expect(decideResumeCursorPersist({
            cursor: 30,
            persistedCursor: 40,
            lastPersistAt: now - RESUME_CURSOR_PERSIST_INTERVAL_MS * 10,
            now,
        })).toBe(false);
    });

    it('throttles an advancing cursor inside the interval', () => {
        // persistSession rewrites the whole sessions.json (600KB on the machine
        // that surfaced this). Runtime reports are frequent, so an advancing
        // cursor alone must not trigger a write on every report.
        expect(decideResumeCursorPersist({
            cursor: 41,
            persistedCursor: 40,
            lastPersistAt: now - (RESUME_CURSOR_PERSIST_INTERVAL_MS - 1),
            now,
        })).toBe(false);
    });

    it('writes an advancing cursor once the interval has passed', () => {
        expect(decideResumeCursorPersist({
            cursor: 41,
            persistedCursor: 40,
            lastPersistAt: now - RESUME_CURSOR_PERSIST_INTERVAL_MS,
            now,
        })).toBe(true);
    });

    it('writes an advancing cursor when nothing was written in this daemon yet', () => {
        // Restored-from-disk sessions carry a persisted cursor but no
        // in-process write timestamp; the first advance after a restart is
        // exactly the value a later hard kill would need.
        expect(decideResumeCursorPersist({
            cursor: 41,
            persistedCursor: 40,
            lastPersistAt: undefined,
            now,
        })).toBe(true);
    });

    it('rejects a non-integer or negative cursor', () => {
        for (const cursor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(decideResumeCursorPersist({
                cursor,
                persistedCursor: undefined,
                lastPersistAt: undefined,
                now,
            })).toBe(false);
        }
    });

    it('accepts cursor 0 as a real first cursor', () => {
        // seq 0 is a valid baseline — treating it as "absent" is what leaves a
        // freshly started session unresumable.
        expect(decideResumeCursorPersist({
            cursor: 0,
            persistedCursor: undefined,
            lastPersistAt: undefined,
            now,
        })).toBe(true);
    });
});
