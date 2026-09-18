import { describe, expect, it } from 'vitest';
import {
    createTerminalOutputBuffer,
    DEFAULT_TERMINAL_BUFFER_CHARS,
} from './terminalOutputBuffer';

describe('terminalOutputBuffer seq assignment', () => {
    it('numbers frames from 1 upwards so 0 can mean "seen nothing"', () => {
        const buffer = createTerminalOutputBuffer();
        expect(buffer.lastSeq()).toBe(0);
        expect(buffer.push('a')).toBe(1);
        expect(buffer.push('b')).toBe(2);
        expect(buffer.lastSeq()).toBe(2);
    });

    it('keeps counting past trimmed frames, because seq is a position not an index', () => {
        const buffer = createTerminalOutputBuffer(4);
        for (const chunk of ['aa', 'bb', 'cc', 'dd']) buffer.push(chunk);
        expect(buffer.lastSeq()).toBe(4);
        expect(buffer.bufferedChars()).toBeLessThanOrEqual(4);
    });
});

describe('terminalOutputBuffer resume', () => {
    it('says nothing when the client is already current', () => {
        const buffer = createTerminalOutputBuffer();
        buffer.push('a');
        expect(buffer.resume(1)).toEqual({ kind: 'none' });
    });

    it('says nothing when the client somehow claims to be ahead', () => {
        const buffer = createTerminalOutputBuffer();
        buffer.push('a');
        expect(buffer.resume(99)).toEqual({ kind: 'none' });
    });

    it('replays exactly the frames after the last one the client saw', () => {
        const buffer = createTerminalOutputBuffer();
        buffer.push('one');
        buffer.push('two');
        buffer.push('three');
        expect(buffer.resume(1)).toEqual({
            kind: 'replay',
            frames: [{ seq: 2, chunk: 'two' }, { seq: 3, chunk: 'three' }],
        });
    });

    it('replays everything for a client that has seen nothing', () => {
        const buffer = createTerminalOutputBuffer();
        buffer.push('one');
        buffer.push('two');
        const answer = buffer.resume(0);
        expect(answer.kind).toBe('replay');
        expect(answer.kind === 'replay' && answer.frames.map((f) => f.chunk)).toEqual(['one', 'two']);
    });

    /*
     * The boundary that decides replay-vs-snapshot. A client whose `afterSeq` is
     * exactly one below the oldest buffered frame has lost nothing — the very
     * next frame we hold is the one it needs.
     */
    it('still replays when the client sits exactly at the buffer edge', () => {
        const buffer = createTerminalOutputBuffer(6);
        buffer.push('aaa');
        buffer.push('bbb');
        buffer.push('ccc'); // trims frame 1
        expect(buffer.resume(1)).toEqual({
            kind: 'replay',
            frames: [{ seq: 2, chunk: 'bbb' }, { seq: 3, chunk: 'ccc' }],
        });
    });

    it('sends a snapshot when the client fell further behind than the buffer reaches', () => {
        const buffer = createTerminalOutputBuffer(6);
        buffer.push('aaa');
        buffer.push('bbb');
        buffer.push('ccc'); // frame 1 is gone
        // afterSeq 0 wants frame 1, which no longer exists — but frames 2..3
        // together are still a coherent screen.
        expect(buffer.resume(0)).toEqual({ kind: 'snapshot', seq: 3, data: 'bbbccc' });
    });

    it('reports a gap rather than a snapshot when nothing is buffered at all', () => {
        const buffer = createTerminalOutputBuffer();
        expect(buffer.resume(0)).toEqual({ kind: 'none' });
    });

    it('reports a gap when every frame was trimmed away', () => {
        // A cap smaller than a single frame trims it immediately, so the buffer
        // is empty while seq has moved on. Lying with an empty snapshot would
        // blank the client's screen; a gap is the honest answer.
        const buffer = createTerminalOutputBuffer(1);
        buffer.push('aaaa');
        buffer.push('bbbb');
        expect(buffer.resume(0)).toEqual({ kind: 'gap', fromSeq: 1 });
    });
});

describe('terminalOutputBuffer bounding', () => {
    it('never drops part of a frame, because a half escape sequence is worse than a gap', () => {
        const buffer = createTerminalOutputBuffer(5);
        buffer.push('abc');
        buffer.push('[31mred');
        const answer = buffer.resume(0);
        // Whatever survived, it survived whole.
        const chunks = answer.kind === 'replay' ? answer.frames.map((f) => f.chunk) : [];
        for (const chunk of chunks) expect(['abc', '[31mred']).toContain(chunk);
    });

    it('holds a long stream to its ceiling', () => {
        const buffer = createTerminalOutputBuffer(1000);
        for (let i = 0; i < 5000; i++) buffer.push('0123456789');
        expect(buffer.bufferedChars()).toBeLessThanOrEqual(1000);
        expect(buffer.lastSeq()).toBe(5000);
    });

    it('defaults to the same ceiling the desktop client buffers to', () => {
        expect(DEFAULT_TERMINAL_BUFFER_CHARS).toBe(1_000_000);
    });
});
