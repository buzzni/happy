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

import { parseSpecialCommand } from '@/parsers/specialCommands';

export type ManagedFollowUp = { localId: string; text: string };

export type ManagedFollowUpRefusal = 'malformed' | 'empty-text' | 'text-too-long' | 'command-not-allowed';

export type ManagedFollowUpParse =
    | ({ ok: true } & ManagedFollowUp)
    | { ok: false; reason: ManagedFollowUpRefusal };

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
    /*
     * `/clear`, `/compact` and the like are not turns: read by the queue they
     * drop turns already accepted, and a retry of one of those would report
     * `duplicate` for a turn that no longer exists. A follow-up is text for
     * the agent, nothing else.
     */
    if (parseSpecialCommand(text).type !== null) return { ok: false, reason: 'command-not-allowed' };
    return { ok: true, localId, text };
}

export type ManagedFollowUpGate = {
    /** Whether this client id is a new turn. The first answer for an id is the only `accepted`. */
    take: (localId: string) => 'accepted' | 'duplicate';
    /** Gives an id back when the turn it was taken for could not be queued. */
    release: (localId: string) => void;
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
        release(localId) {
            if (!index.delete(localId)) return;
            const at = seen.indexOf(localId);
            if (at >= 0) seen.splice(at, 1);
        },
    };
}

export type ManagedFollowUpAnswer =
    | { accepted: true; duplicate?: true }
    | { accepted: false; reason: 'not-managed' | 'not-accepting' | ManagedFollowUpRefusal };

/**
 * The `follow-up` RPC handler, the same for every agent.
 *
 * Nothing is awaited between the gate and the queue, so `accepted` means the
 * turn is in the queue when the caller reads it. The queue goes first: it is
 * the one step that can refuse (a run winding down closes it), and a turn
 * shown but never queued is a question with no answer. The visible row is
 * still queued to the socket in the same tick, before any provider output can
 * exist, so the transcript order holds. A refused queue gives the client id
 * back — a retry of that send must be a turn, not a `duplicate` of nothing.
 */
export function createManagedFollowUpHandler(deps: {
    /** Whether this run is managed. Read per call: it is decided after startup. */
    managed: () => boolean;
    /** Shows the turn as the user's own row, without touching the turn in progress. */
    echo: (turn: ManagedFollowUp) => void;
    /** Places the text in the turn queue with the options the run already has. */
    enqueue: (text: string) => void;
    gate?: ManagedFollowUpGate;
}): (params: unknown) => Promise<ManagedFollowUpAnswer> {
    const gate = deps.gate ?? createManagedFollowUpGate();
    return async (params) => {
        if (!deps.managed()) return { accepted: false, reason: 'not-managed' };
        const parsed = parseManagedFollowUp(params);
        if (!parsed.ok) return { accepted: false, reason: parsed.reason };
        if (gate.take(parsed.localId) === 'duplicate') return { accepted: true, duplicate: true };
        try {
            deps.enqueue(parsed.text);
        } catch {
            gate.release(parsed.localId);
            return { accepted: false, reason: 'not-accepting' };
        }
        deps.echo({ localId: parsed.localId, text: parsed.text });
        return { accepted: true };
    };
}
