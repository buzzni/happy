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

const MAX_STREAM_TEXT_IDENTIFIER_BYTES = 128;
const MAX_STREAM_TEXT_CONTENT_BYTES = 1024 * 1024;
const BASE64_CIPHERTEXT_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function boundedNonEmptyString(value: unknown, maxBytes: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

export function parseStreamTextPayload(raw: unknown): StreamTextPayload | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const { sid, turnId, blockIndex, content } = raw as Record<string, unknown>;

    if (!boundedNonEmptyString(sid, MAX_STREAM_TEXT_IDENTIFIER_BYTES)) return null;
    if (!boundedNonEmptyString(turnId, MAX_STREAM_TEXT_IDENTIFIER_BYTES)) return null;
    if (!boundedNonEmptyString(content, MAX_STREAM_TEXT_CONTENT_BYTES)) return null;
    if (content.length % 4 !== 0 || !BASE64_CIPHERTEXT_PATTERN.test(content)) return null;
    if (typeof blockIndex !== 'number' || !Number.isInteger(blockIndex) || blockIndex < 0) return null;

    return { sid, turnId, blockIndex, content };
}
