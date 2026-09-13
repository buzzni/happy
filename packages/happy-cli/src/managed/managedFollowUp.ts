/**
 * The next turn of a managed session, as the child reads it (T07-L5-b).
 *
 * A managed run is admitted for exactly one prompt; every option — model,
 * effort, permission mode, system prompt, tools — was fixed then. A follow-up
 * changes none of that: it is **text only**, taken into the same turn queue
 * with the options the run already has. The sealed payload may carry more
 * (a client that sends a full user message shape); everything but the text
 * and the client id is ignored here, so the run can never be re-optioned
 * from outside its admission.
 *
 * Retries are a fact of the relay: a sender that lost the acknowledgement
 * sends the same turn again. The client id is what makes one send one turn.
 */

export type ManagedFollowUp = { localId: string; text: string };

export type ManagedFollowUpParse =
    | ({ ok: true } & ManagedFollowUp)
    | { ok: false; reason: 'malformed' | 'empty-text' | 'text-too-long' };

/** Generous for a chat turn, small for a payload nobody has inspected. */
export const MANAGED_FOLLOW_UP_MAX_TEXT = 200_000;

export function parseManagedFollowUp(params: unknown): ManagedFollowUpParse {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, reason: 'malformed' };
    const record = params as Record<string, unknown>;
    const localId = record.localId;
    const text = record.text;
    if (typeof localId !== 'string' || localId.length === 0 || localId.length > 200) return { ok: false, reason: 'malformed' };
    if (typeof text !== 'string') return { ok: false, reason: 'malformed' };
    if (text.trim().length === 0) return { ok: false, reason: 'empty-text' };
    if (text.length > MANAGED_FOLLOW_UP_MAX_TEXT) return { ok: false, reason: 'text-too-long' };
    return { ok: true, localId, text };
}

export type ManagedFollowUpGate = {
    /** Whether this client id is a new turn. The first answer for an id is the only `accepted`. */
    take: (localId: string) => 'accepted' | 'duplicate';
};

/**
 * Remembers the client ids already taken, oldest first out. Bounded: a run
 * that lives for hours must not grow this without limit, and a retry arrives
 * within seconds of its original, not thousands of turns later.
 */
export function createManagedFollowUpGate(options: { remember?: number } = {}): ManagedFollowUpGate {
    const remember = Math.max(1, options.remember ?? 1_000);
    const seen: string[] = [];
    const index = new Set<string>();
    return {
        take(localId) {
            if (index.has(localId)) return 'duplicate';
            index.add(localId);
            seen.push(localId);
            while (seen.length > remember) {
                const dropped = seen.shift();
                if (dropped !== undefined) index.delete(dropped);
            }
            return 'accepted';
        },
    };
}
