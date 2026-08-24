/**
 * Decides when a session's resume cursor must be written to disk.
 *
 * 2026-08-24 finding: `lastProcessedSeq` reached disk only through
 * `preserveSessionForResume`, which runs on a clean stop (idle reaper, stop
 * RPC, child exit). A daemon that dies without those handlers — pod eviction,
 * OOM, SIGKILL — leaves every session it was running at its start-time
 * snapshot: no cursor. Resume then refuses with `SESSION_CURSOR_MISSING`, and
 * the untracked-recovery fallback refuses too when the start snapshot also
 * predates `claudeSessionId`. On one prod machine that was 15 of 86 persisted
 * sessions, and none of the 15 had ever gone through a clean stop.
 *
 * Runtime reports carry the cursor continuously, so writing from that path
 * closes the gap. `persistSession` rewrites the entire sessions.json, so an
 * advancing cursor is throttled — but the *first* cursor is written at once,
 * because that write is what turns an unresumable session into a resumable one.
 */

/** Minimum gap between disk writes for a cursor that keeps advancing. */
export const RESUME_CURSOR_PERSIST_INTERVAL_MS = 30_000;

export interface ResumeCursorPersistInput {
    /** Cursor just reported by the session, if it reported one. */
    cursor?: number;
    /** Cursor already on disk for this session, if any. */
    persistedCursor?: number;
    /** When this daemon last wrote a cursor for this session. */
    lastPersistAt?: number;
    now: number;
    intervalMs?: number;
}

export function decideResumeCursorPersist(input: ResumeCursorPersistInput): boolean {
    const { cursor, persistedCursor, lastPersistAt, now } = input;
    const intervalMs = input.intervalMs ?? RESUME_CURSOR_PERSIST_INTERVAL_MS;

    if (cursor === undefined) return false;
    if (!Number.isInteger(cursor) || cursor < 0) return false;

    // Nothing on disk yet: this write is the difference between a resumable
    // session and one that is stranded by the next hard kill. Do not throttle.
    if (persistedCursor === undefined) return true;

    // Monotonic — a delayed or out-of-order report must never move the on-disk
    // baseline backwards, or a resume would replay already-processed messages.
    if (cursor <= persistedCursor) return false;

    if (lastPersistAt === undefined) return true;
    return now - lastPersistAt >= intervalMs;
}
