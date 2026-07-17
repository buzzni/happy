/**
 * Fallback chat titles.
 *
 * Every agent's system prompt instructs the model to call the happy
 * `change_title` tool on its first turn, but that is a soft instruction the
 * model sometimes skips — most visibly for rambling, low-signal
 * voice-transcribed first messages, which leaves the chat stuck on its
 * placeholder title. This derives a deterministic title from the first user
 * message so a session always ends up with something findable.
 */

const MAX_LEN = 50;

/**
 * Build a title from a user message, or null when the message is unusable as
 * one (empty, or a slash command such as `/clear`, which is control input
 * rather than a description of the task).
 */
export function buildFallbackTitle(text: string): string | null {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed) {
        return null;
    }
    if (collapsed.startsWith('/')) {
        return null;
    }
    // Split by code points (not UTF-16 units) so truncation never cuts an
    // emoji/surrogate pair in half and leaves a broken trailing character.
    const chars = Array.from(collapsed);
    if (chars.length <= MAX_LEN) {
        return collapsed;
    }
    return chars.slice(0, MAX_LEN).join('').trimEnd() + '…';
}
