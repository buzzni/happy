import { describe, expect, it } from 'vitest';
import {
    createStreamTextCoalescer,
    STREAM_TEXT_COALESCE_MS,
    STREAM_TEXT_MAX_CHUNK_CHARS,
} from './streamTextCoalescer';

function textStart(index: number) {
    return { type: 'content_block_start' as const, index, content_block: { type: 'text' as const, text: '' } };
}
function toolStart(index: number) {
    return { type: 'content_block_start' as const, index, content_block: { type: 'tool_use' as const, id: 't1', name: 'Bash', input: {} } };
}
function thinkingStart(index: number) {
    return { type: 'content_block_start' as const, index, content_block: { type: 'thinking' as const, thinking: '', signature: '' } };
}
function textDelta(index: number, text: string) {
    return { type: 'content_block_delta' as const, index, delta: { type: 'text_delta' as const, text } };
}
function thinkingDelta(index: number, thinking: string) {
    return { type: 'content_block_delta' as const, index, delta: { type: 'thinking_delta' as const, thinking } };
}
function stop(index: number) {
    return { type: 'content_block_stop' as const, index };
}

describe('createStreamTextCoalescer', () => {
    it('emits nothing until the coalescing window elapses', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);
        expect(coalescer.push(textDelta(0, 'Hel'), 10)).toEqual([]);
        expect(coalescer.push(textDelta(0, 'lo'), 30)).toEqual([]);
    });

    it('emits incremental text with a monotonic sequence once the window elapses', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);
        coalescer.push(textDelta(0, 'Hel'), 10);
        const first = coalescer.push(textDelta(0, 'lo'), 10 + STREAM_TEXT_COALESCE_MS);
        const second = coalescer.push(textDelta(0, '!'), 10 + STREAM_TEXT_COALESCE_MS * 2);

        expect(first).toEqual([{ turnId: 'turn-1', blockIndex: 0, sequence: 0, delta: 'Hello' }]);
        expect(second).toEqual([{ turnId: 'turn-1', blockIndex: 0, sequence: 1, delta: '!' }]);
    });

    it('tracks multiple text blocks independently by index', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);
        coalescer.push(textDelta(0, 'first'), 0);
        coalescer.push(stop(0), 0);
        coalescer.push(textStart(1), 0);
        const chunks = coalescer.push(textDelta(1, 'second'), STREAM_TEXT_COALESCE_MS);

        expect(chunks).toEqual([{ turnId: 'turn-1', blockIndex: 1, sequence: 0, delta: 'second' }]);
    });

    it('ignores thinking-block deltas even though the delta shape overlaps text', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(thinkingStart(0), 0);
        const result = coalescer.push(thinkingDelta(0, 'pondering'), STREAM_TEXT_COALESCE_MS);

        expect(result).toEqual([]);
    });

    it('ignores tool_use-block deltas', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(toolStart(0), 0);
        // A tool_use block streams input_json_delta, not text_delta — no text ever arrives,
        // but confirm the block-type gate itself, not just delta-shape absence.
        const result = coalescer.push(
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
            STREAM_TEXT_COALESCE_MS,
        );

        expect(result).toEqual([]);
    });

    it('drops tracked state for a block once it stops, so a stray late delta is ignored', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);
        coalescer.push(textDelta(0, 'a'), 0);
        coalescer.push(stop(0), 0);

        // A delta for an index the coalescer no longer tracks — happens for
        // out-of-order delivery or a bug upstream. Must not throw or resurrect state.
        const result = coalescer.push(textDelta(0, 'b'), STREAM_TEXT_COALESCE_MS);
        expect(result).toEqual([]);
    });

    it('flushes immediately on demand regardless of the window', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);
        coalescer.push(textDelta(0, 'partial'), 0);

        expect(coalescer.flush(0, 5)).toEqual([{
            turnId: 'turn-1',
            blockIndex: 0,
            sequence: 0,
            delta: 'partial',
        }]);
        // A second immediate flush with nothing new to say is empty, not a repeat.
        expect(coalescer.flush(0, 5)).toEqual([]);
    });

    it('never emits for an empty accumulated string', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);
        const result = coalescer.push(textDelta(0, ''), STREAM_TEXT_COALESCE_MS);
        expect(result).toEqual([]);
    });

    it('ignores an event for an index that never had a content_block_start', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        const result = coalescer.push(textDelta(5, 'orphan'), STREAM_TEXT_COALESCE_MS);
        expect(result).toEqual([]);
    });

    it('bounds every chunk and keeps total emitted text linear in source size', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);

        const delta = 'abcd';
        const chunks = 32_768;
        const emitted: string[] = [];
        for (let i = 1; i <= chunks; i += 1) {
            const output = coalescer.push(textDelta(0, delta), i * 20);
            emitted.push(...output.map((chunk) => chunk.delta));
        }

        expect(emitted.join('').length).toBe(chunks * delta.length);
        expect(emitted.every((chunk) => chunk.length <= STREAM_TEXT_MAX_CHUNK_CHARS)).toBe(true);
    });

    it('splits a single oversized delta into bounded sequential chunks', () => {
        const coalescer = createStreamTextCoalescer({ turnId: 'turn-1' });
        coalescer.push(textStart(0), 0);
        const text = 'x'.repeat(STREAM_TEXT_MAX_CHUNK_CHARS * 2 + 1);

        const chunks = coalescer.push(textDelta(0, text), STREAM_TEXT_COALESCE_MS);

        expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
        expect(chunks.map((chunk) => chunk.delta.length)).toEqual([
            STREAM_TEXT_MAX_CHUNK_CHARS,
            STREAM_TEXT_MAX_CHUNK_CHARS,
            1,
        ]);
        expect(chunks.map((chunk) => chunk.delta).join('')).toBe(text);
    });
});
