import { describe, expect, it } from 'vitest';
import {
    createTerminalOutputBuffer,
    DEFAULT_TERMINAL_BUFFER_CHARS,
    DEFAULT_TERMINAL_BUFFER_FRAMES,
    TERMINAL_RESUME_PAGE_CHARS,
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

/*
 * specs/codexcli-daemon-stream-durability B-R3 — a resume that names `maxChars`
 * is answered one page at a time, so a 1M-char backlog never travels as one
 * message. A page never splits a frame (a half escape sequence is worse than a
 * short page), and a resume without `maxChars` keeps the old one-shot answer.
 */
describe('terminalOutputBuffer paged resume (B-R3)', () => {
    function fill(buffer: ReturnType<typeof createTerminalOutputBuffer>, frames: number, size: number) {
        for (let i = 0; i < frames; i++) buffer.push(String(i % 10).repeat(size));
    }

    it('answers a full 1M-char buffer in at most 4 pages of 256K without splitting a frame', () => {
        const buffer = createTerminalOutputBuffer();
        fill(buffer, 250, 4_000); // exactly 1,000,000 chars, all still buffered
        const pushed: Array<{ seq: number; chunk: string }> = [];
        let afterSeq = 0;
        let pages = 0;
        for (;;) {
            const answer = buffer.resume(afterSeq, TERMINAL_RESUME_PAGE_CHARS);
            expect(answer.kind).toBe('replay');
            if (answer.kind !== 'replay') break;
            pages += 1;
            const pageChars = answer.frames.reduce((n, f) => n + f.chunk.length, 0);
            expect(pageChars).toBeLessThanOrEqual(TERMINAL_RESUME_PAGE_CHARS);
            pushed.push(...answer.frames);
            afterSeq = answer.frames[answer.frames.length - 1].seq;
            expect(answer.nextSeq).toBe(afterSeq);
            if (!answer.more) break;
        }
        expect(pages).toBeLessThanOrEqual(4);
        expect(pushed.map((f) => f.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
        for (const frame of pushed) expect(frame.chunk.length).toBe(4_000);
    });

    it('still hands over a frame larger than the page, whole, so paging always advances', () => {
        const buffer = createTerminalOutputBuffer();
        buffer.push('x'.repeat(10));
        buffer.push('y'.repeat(10));
        const answer = buffer.resume(0, 4);
        expect(answer).toEqual({ kind: 'replay', frames: [{ seq: 1, chunk: 'x'.repeat(10) }], more: true, nextSeq: 1 });
    });

    it('marks the last page with more:false', () => {
        const buffer = createTerminalOutputBuffer();
        buffer.push('aa');
        buffer.push('bb');
        expect(buffer.resume(0, 100)).toEqual({
            kind: 'replay',
            frames: [{ seq: 1, chunk: 'aa' }, { seq: 2, chunk: 'bb' }],
            more: false,
            nextSeq: 2,
        });
    });

    it('caps a caller-supplied page size at the protocol maximum', () => {
        const buffer = createTerminalOutputBuffer();
        fill(buffer, 100, 4_000);
        const answer = buffer.resume(0, 10_000_000);
        expect(answer.kind === 'replay' && answer.frames.reduce((n, f) => n + f.chunk.length, 0))
            .toBeLessThanOrEqual(TERMINAL_RESUME_PAGE_CHARS);
    });

    it('turns a snapshot into a reset plus the first page, and says how much output was lost for good', () => {
        const buffer = createTerminalOutputBuffer(9);
        buffer.push('aaa');
        buffer.push('bbb');
        buffer.push('ccc');
        buffer.push('ddd'); // frame 1 (3 chars) is gone
        const first = buffer.resume(0, 4);
        expect(first).toEqual({ kind: 'snapshot', seq: 2, data: 'bbb', more: true, nextSeq: 2, droppedChars: 3 });
        // The rest is ordinary replay after the snapshot's seq.
        expect(buffer.resume(2, 100)).toEqual({
            kind: 'replay',
            frames: [{ seq: 3, chunk: 'ccc' }, { seq: 4, chunk: 'ddd' }],
            more: false,
            nextSeq: 4,
        });
    });

    it('counts only the lost output after the client\'s own position', () => {
        const buffer = createTerminalOutputBuffer(6);
        for (const chunk of ['a', 'bb', 'ccc', 'dddd', 'eeeee']) buffer.push(chunk);
        // Buffered: 'eeeee' (seq 5) only. A client at seq 2 lost 'ccc'+'dddd'.
        const answer = buffer.resume(2, 100);
        expect(answer.kind).toBe('snapshot');
        expect(answer.kind === 'snapshot' && answer.droppedChars).toBe(7);
    });

    it('reports the lost characters on a paged gap too', () => {
        const buffer = createTerminalOutputBuffer(1);
        buffer.push('aaaa');
        buffer.push('bbbb');
        expect(buffer.resume(1, 100)).toEqual({ kind: 'gap', fromSeq: 2, droppedChars: 4 });
    });

    it('keeps the one-shot answer exactly as before when maxChars is absent', () => {
        const buffer = createTerminalOutputBuffer(6);
        buffer.push('aaa');
        buffer.push('bbb');
        buffer.push('ccc');
        expect(buffer.resume(0)).toEqual({ kind: 'snapshot', seq: 3, data: 'bbbccc' });
        expect(buffer.resume(1)).toEqual({ kind: 'replay', frames: [{ seq: 2, chunk: 'bbb' }, { seq: 3, chunk: 'ccc' }] });
    });
});
