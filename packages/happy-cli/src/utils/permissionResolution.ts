/**
 * How a permission request stopped being answerable (aplus-dev-studio
 * specs/codexcli-approval-session-binding plan §3.2·§3.4).
 *
 * Every path a request leaves by — answered, stopped, a turn or generation ending, a reset,
 * shutdown, the next process starting, or an unattended wait running out — writes one of these
 * into `completedRequests[id].resolution`. Clients read it to close the card on every screen and
 * to tell a late answer what happened; it never says who answered or what they chose.
 *
 * `auto-approved` marks a call the runtime approved itself (Codex `codex_apps`·`change_title`,
 * Gemini's always-allowed tools and yolo modes): it never waited, so clients skip it rather than
 * guess it from the record's shape (aplus-dev-studio I6k). Claude's own allow paths write no record.
 */

export type PermissionResolution =
    | 'answered'
    | 'aborted'
    | 'generation-ended'
    | 'turn-ended'
    | 'expired'
    | 'reset'
    | 'shutdown'
    | 'runtime-restart'
    | 'auto-approved';

/**
 * What the child says it did with an answer.
 *
 * Returned through the ordinary RPC path, which seals it with the session key — so the browser
 * that sent the answer can read it and nothing in between can. Older clients ignore the body,
 * which is what they did when it was `undefined`.
 */
export interface PermissionAck {
    applied: boolean;
    /** Why not, when it was not. */
    reason?: 'unknown-request' | 'already-answered' | 'expired';
}

/** How many settled ids one process remembers for late answers (plan §3.4). */
export const RESOLVED_PERMISSION_LOG_LIMIT = 512;

/**
 * The ids this process settled, newest last, bounded.
 *
 * Kept apart from anything a reset clears, so an answer that arrives after the turn ended is told
 * `already-answered` or `expired` instead of `unknown-request`. A `Map` keyed by the provider's
 * request id: ids are untrusted strings, and a plain object would read `__proto__` as present.
 */
export class ResolvedPermissionLog {
    private readonly entries = new Map<string, PermissionResolution>();

    constructor(private readonly limit: number = RESOLVED_PERMISSION_LOG_LIMIT) { }

    record(id: string, resolution: PermissionResolution): void {
        // Re-inserting moves the id to the newest end, so a re-raised id is not evicted early.
        this.entries.delete(id);
        this.entries.set(id, resolution);
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    get(id: string): PermissionResolution | undefined {
        return this.entries.get(id);
    }

    /** The refusal for an answer to a request that is no longer waiting. */
    ackFor(id: string): PermissionAck {
        const resolution = this.entries.get(id);
        if (resolution === 'answered') return { applied: false, reason: 'already-answered' };
        if (resolution === 'expired') return { applied: false, reason: 'expired' };
        return { applied: false, reason: 'unknown-request' };
    }
}
