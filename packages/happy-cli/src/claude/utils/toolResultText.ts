/**
 * Tool result text for `tool-call-end.result` — Saycode specs/chat-tool-result-output R16.
 *
 * Order: collect (a string body, or the `text` blocks of an array body joined with `\n`;
 * other blocks such as images are skipped) → remove ANSI escapes → `\r\n` to `\n` → clamp.
 * Lengths are counted in code points, so a cut never splits a surrogate pair and a reader can
 * always put the omission marker after the first `TOOL_RESULT_HEAD_CHARS` code points.
 * Desktop applies the same limits on receipt; the repos share no package, so keep the
 * constants and the order in step with its `src/domain/toolResultText.ts`.
 */

export const TOOL_RESULT_MAX_CHARS = 16_000;
export const TOOL_RESULT_HEAD_CHARS = 6_000;
export const TOOL_RESULT_TAIL_CHARS = 10_000;

export type ToolResultText = { text: string; isError?: boolean; omitted?: number };

// Escape sequences — the text is shown plain, never colored. A terminated OSC (window title,
// hyperlink) goes as a whole whatever its payload; the rest is the `ansi-regex` pattern.
const ANSI_ESCAPE = new RegExp([
    '(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C)',
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
].join('|'), 'g');

/**
 * The text a Claude `tool_result` returned, or undefined when it carries no text and no error flag.
 * Callers must not call this for policy-redacted tools (`shouldRedact`).
 */
export function toolResultText(content: unknown, isError: unknown): ToolResultText | undefined {
    const texts = typeof content === 'string'
        ? [content]
        : Array.isArray(content)
            ? content
                .filter((block): block is { type: 'text'; text: string } => (
                    !!block && typeof block === 'object'
                    && (block as { type?: unknown }).type === 'text'
                    && typeof (block as { text?: unknown }).text === 'string'
                ))
                .map((block) => block.text)
            : [];
    if (texts.length === 0 && isError !== true) return undefined;
    const plain = texts.join('\n').replace(ANSI_ESCAPE, '').replace(/\r\n/g, '\n');
    const flag = isError === true ? { isError: true } : {};
    // Code points never outnumber UTF-16 units, so a short string skips the split.
    const chars = plain.length > TOOL_RESULT_MAX_CHARS ? Array.from(plain) : null;
    if (!chars || chars.length <= TOOL_RESULT_MAX_CHARS) return { text: plain, ...flag };
    return {
        text: chars.slice(0, TOOL_RESULT_HEAD_CHARS).join('') + chars.slice(-TOOL_RESULT_TAIL_CHARS).join(''),
        ...flag,
        omitted: chars.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS,
    };
}
