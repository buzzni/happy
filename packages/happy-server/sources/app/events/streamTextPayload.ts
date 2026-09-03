/**
 * Validates the `session-stream-text` socket payload
 * (specs/desktop-speed-breakthrough-token-streaming T2).
 *
 * Every other socket handler in this file inlines its own validation as loose
 * `data: any` destructuring — this one is pulled out pure so it is testable
 * without a socket.io server, and so the fail-closed shape checks (integer,
 * non-negative, non-empty) are pinned instead of re-typed at each call site.
 */

export interface StreamTextPayload {
    sid: string;
    turnId: string;
    blockIndex: number;
    content: string;
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export function parseStreamTextPayload(raw: unknown): StreamTextPayload | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const { sid, turnId, blockIndex, content } = raw as Record<string, unknown>;

    if (!nonEmptyString(sid)) return null;
    if (!nonEmptyString(turnId)) return null;
    if (!nonEmptyString(content)) return null;
    if (typeof blockIndex !== 'number' || !Number.isInteger(blockIndex) || blockIndex < 0) return null;

    return { sid, turnId, blockIndex, content };
}
