/**
 * What the model reads when a person denies a tool use (aplus-dev-studio specs/permission-deny-reason).
 *
 * A permission answer can carry two texts:
 * - `userReason` — only what the person wrote. The runtime keeps the default instruction ("the tool was
 *   not run, stop and wait") in front of it, so the model still stops.
 * - `reason` — a complete message, used verbatim. Desktop builds up to happy-cli .357 send the default
 *   sentence and the person's reason already joined here; prefixing it again would repeat the sentence.
 *
 * `userReason` wins when both are sent, unless it cleans to nothing (blank, or control characters only):
 * then `reason` is used as if `userReason` had not been sent.
 */

/** Desktop's reason input stops at 2,000 characters (`PermissionDenyReason.tsx` maxLength). */
export const USER_REASON_MAX_LENGTH = 2000;

// C0 and C1 controls and DEL, except tab and line feed. Line breaks are normalized to `\n` first.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function composeDenyMessage(defaultMessage: string, answer: { reason?: string; userReason?: string }): string {
    const userReason = cleanUserReason(answer.userReason);
    if (userReason) return `${defaultMessage}\n\nUser's reason: ${userReason}`;
    if (typeof answer.reason === 'string' && answer.reason.trim()) return answer.reason;
    return defaultMessage;
}

/**
 * A tool policy deny never carried a default sentence from any client, so there the legacy `reason`
 * is the person's own too and goes after the blocked text like `userReason` does.
 */
export function composePolicyDenyMessage(defaultMessage: string, answer: { reason?: string; userReason?: string }): string {
    return composeDenyMessage(defaultMessage, { userReason: cleanUserReason(answer.userReason) ?? answer.reason });
}

/**
 * The reason kept on `completedRequests[id]`, which clients show as the denial's reason. The person's
 * own one first, so the record and the model agree; otherwise the legacy `reason` as it came.
 */
export function recordedDenyReason(answer: { reason?: string; userReason?: string }): string | undefined {
    return cleanUserReason(answer.userReason) ?? answer.reason;
}

/** The person's reason as the model may read it, or undefined when there is none. */
function cleanUserReason(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARACTERS, '').trim();
    if (!cleaned) return undefined;
    // By code point, so a cut never leaves half a surrogate pair.
    const characters = Array.from(cleaned);
    return characters.length > USER_REASON_MAX_LENGTH
        ? `${characters.slice(0, USER_REASON_MAX_LENGTH).join('')}…`
        : cleaned;
}
