import { describe, expect, it } from 'vitest';
import {
    TOOL_RESULT_HEAD_CHARS,
    TOOL_RESULT_MAX_CHARS,
    TOOL_RESULT_TAIL_CHARS,
    toolResultText,
} from './toolResultText';

describe('toolResultText', () => {
    it('removes ANSI color, cursor and OSC sequences and normalizes CRLF', () => {
        const raw = '\u001b[1m\u001b[31mFAIL\u001b[0m src/a.test.ts\r\n\u001b[2K\u001b[1Gdone\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007\rprogress';
        expect(toolResultText(raw, false)).toEqual({ text: 'FAIL src/a.test.ts\ndonelink\rprogress' });
    });

    it('removes a whole OSC sequence whose payload has spaces, with either terminator', () => {
        expect(toolResultText('\u001b]0;my command\u0007text \u001b]2;window title here\u001b\\done', false)).toEqual({ text: 'text done' });
    });

    // Every OSC start must stop at the next one: otherwise each scans to the end and the strip is quadratic.
    it('strips an escape-heavy body in linear time', () => {
        const started = performance.now();
        expect(toolResultText('\u009D'.repeat(100_000) + 'ok', false)).toMatchObject({ omitted: 100_002 - TOOL_RESULT_MAX_CHARS });
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('keeps an empty body and an error without text, but nothing for a body with no text', () => {
        expect(toolResultText('', undefined)).toEqual({ text: '' });
        expect(toolResultText(undefined, true)).toEqual({ text: '', isError: true });
        expect(toolResultText([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }], false)).toBeUndefined();
        expect(toolResultText(undefined, undefined)).toBeUndefined();
    });

    it('keeps exactly the limit untouched', () => {
        const text = 'a'.repeat(TOOL_RESULT_MAX_CHARS);
        expect(toolResultText(text, false)).toEqual({ text });
    });

    // Head + tail + omitted must add up to the cleaned length, counted in code points,
    // so the reader knows the cut is right after the first TOOL_RESULT_HEAD_CHARS code points.
    it('cuts on code points, never inside a surrogate pair, and counts what it dropped', () => {
        const head = 'h'.repeat(TOOL_RESULT_HEAD_CHARS - 1) + '😀';
        const tail = '😀' + 't'.repeat(TOOL_RESULT_TAIL_CHARS - 1);
        const middle = 'm'.repeat(123) + '\u001b[32m' + '\r\n';
        const result = toolResultText(head + middle + tail, true)!;
        expect(result).toEqual({ text: head + tail, isError: true, omitted: 124 });
        const chars = Array.from(result.text);
        expect(chars.slice(0, TOOL_RESULT_HEAD_CHARS).join('')).toBe(head);
        expect(chars.slice(TOOL_RESULT_HEAD_CHARS).join('')).toBe(tail);
        expect(chars.length + result.omitted!).toBe(Array.from(head + 'm'.repeat(123) + '\n' + tail).length);
    });

    it('counts code points, so a long emoji body under the limit in code points is kept whole', () => {
        const text = '😀'.repeat(TOOL_RESULT_MAX_CHARS);
        expect(text.length).toBe(TOOL_RESULT_MAX_CHARS * 2);
        expect(toolResultText(text, false)).toEqual({ text });
    });
});
