import { describe, expect, it } from 'vitest';
import {
    createTerminalOutputBuffer,
    DEFAULT_TERMINAL_BUFFER_CHARS,
    DEFAULT_TERMINAL_BUFFER_FRAMES,
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

    /*
     * The character cap alone does not bound memory: each retained frame costs
     * its object, its array slot and a string header on top of the characters
     * it accounts for (~47 bytes measured), so a buffer full of one-character
     * frames sits at ~47MB while reporting 1,000,000 chars. A slow steady
     * printer reaches that through the coalescer's 8ms flush window without any
     * adversary, so the frame count is capped too.
     */
    it('caps the frame count, not just the characters', () => {
        const buffer = createTerminalOutputBuffer(DEFAULT_TERMINAL_BUFFER_CHARS, 10);
        for (let i = 0; i < 100; i++) buffer.push('.');
        // Well under the character cap, so only the frame cap can be holding it.
        expect(buffer.bufferedChars()).toBe(10);
        expect(buffer.lastSeq()).toBe(100);
        expect(buffer.resume(95)).toEqual({
            kind: 'replay',
            frames: [96, 97, 98, 99, 100].map((seq) => ({ seq, chunk: '.' })),
        });
    });

    it('trims whole frames when the frame cap is what bites', () => {
        const buffer = createTerminalOutputBuffer(DEFAULT_TERMINAL_BUFFER_CHARS, 2);
        buffer.push('abc');
        buffer.push('[31mred');
        buffer.push('xyz');
        // Frame 1 is gone, so a client at 0 has fallen past the buffer — and
        // what it gets back is the surviving frames whole, never a half escape
        // sequence.
        expect(buffer.resume(0)).toEqual({ kind: 'snapshot', seq: 3, data: '[31mredxyz' });
    });

    it('defaults the frame ceiling to the same order of magnitude as the character one', () => {
        expect(DEFAULT_TERMINAL_BUFFER_FRAMES).toBe(20_000);
    });
});
