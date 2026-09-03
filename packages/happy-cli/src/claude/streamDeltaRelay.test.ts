import { describe, expect, it, vi } from 'vitest';
import { createStreamDeltaRelay, DEFAULT_STREAM_MAX_BYTES, type StreamDeltaFrame } from './streamDeltaRelay';

function relayWithFakeTimers(opts: { flushMs?: number; maxBytes?: number } = {}) {
    const frames: StreamDeltaFrame[] = [];
    const timers: { cb: () => void; ms: number }[] = [];
    const relay = createStreamDeltaRelay({
        emit: (frame) => frames.push(frame),
        flushMs: opts.flushMs,
        maxBytes: opts.maxBytes,
        setTimer: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
        clearTimer: () => {},
    });
    const fire = () => { const t = timers.shift(); t?.cb(); };
    return { relay, frames, timers, fire };
}

const messageStart = (id: string) => ({
    type: 'stream_event', uuid: 'u', session_id: 's', parent_tool_use_id: null,
    event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [] } },
});
const textDelta = (index: number, text: string) => ({
    type: 'stream_event', uuid: 'u', session_id: 's', parent_tool_use_id: null,
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
});
const blockStop = (index: number) => ({
    type: 'stream_event', uuid: 'u', session_id: 's', parent_tool_use_id: null,
    event: { type: 'content_block_stop', index },
});

describe('streamDeltaRelay', () => {
    it('coalesces text deltas of one block into a single frame per flush window', () => {
        const { relay, frames, timers, fire } = relayWithFakeTimers({ flushMs: 80 });
        relay.handleStreamEvent(messageStart('msg_a') as any);
        relay.handleStreamEvent(textDelta(0, 'Hel') as any);
        relay.handleStreamEvent(textDelta(0, 'lo ') as any);
        relay.handleStreamEvent(textDelta(0, 'world') as any);

        expect(frames).toEqual([]);
        expect(timers).toHaveLength(1);
        expect(timers[0].ms).toBe(80);
        fire();
        expect(frames).toEqual([{ messageId: 'msg_a', index: 0, offset: 0, delta: 'Hello world', final: false }]);
    });

    it('flushes early when buffered bytes reach maxBytes and carries the block offset already sent', () => {
        const { relay, frames, fire } = relayWithFakeTimers({ maxBytes: 4 });
        relay.handleStreamEvent(messageStart('msg_a') as any);
        relay.handleStreamEvent(textDelta(0, 'ab') as any);
        relay.handleStreamEvent(textDelta(0, 'cd') as any);
        expect(frames.map((f) => f.delta)).toEqual(['abcd']);
        relay.handleStreamEvent(textDelta(0, 'e') as any);
        fire();
        expect(frames.map((f) => [f.offset, f.delta])).toEqual([[0, 'abcd'], [4, 'e']]);
    });

    it('keeps every emitted frame within the default limit when the threshold is crossed mid-delta', () => {
        const { relay, frames, fire } = relayWithFakeTimers();
        relay.handleStreamEvent(messageStart('msg_a') as any);
        relay.handleStreamEvent(textDelta(0, 'a'.repeat(DEFAULT_STREAM_MAX_BYTES - 8)) as any);
        relay.handleStreamEvent(textDelta(0, 'b'.repeat(20)) as any);

        expect(frames.map((f) => [f.offset, f.delta.length])).toEqual([
            [0, DEFAULT_STREAM_MAX_BYTES],
            [DEFAULT_STREAM_MAX_BYTES, 12],
        ]);
        relay.handleStreamEvent(textDelta(0, 'c') as any);
        fire();
        expect(frames.at(-1)).toMatchObject({ offset: DEFAULT_STREAM_MAX_BYTES + 12, delta: 'c' });
    });

    it('marks the block final on content_block_stop and flushes immediately', () => {
        const { relay, frames } = relayWithFakeTimers();
        relay.handleStreamEvent(messageStart('msg_a') as any);
        relay.handleStreamEvent(textDelta(0, 'done') as any);
        relay.handleStreamEvent(blockStop(0) as any);
        expect(frames).toEqual([{ messageId: 'msg_a', index: 0, offset: 0, delta: 'done', final: true }]);
    });

    it('ignores subagent streams, non-text deltas and events before message_start', () => {
        const { relay, frames, fire } = relayWithFakeTimers();
        relay.handleStreamEvent(textDelta(0, 'orphan') as any);
        relay.handleStreamEvent(messageStart('msg_a') as any);
        relay.handleStreamEvent({ ...textDelta(0, 'sub'), parent_tool_use_id: 'toolu_1' } as any);
        relay.handleStreamEvent({
            type: 'stream_event', uuid: 'u', session_id: 's', parent_tool_use_id: null,
            event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        } as any);
        fire();
        expect(frames).toEqual([]);
    });

    it('keeps blocks of different messages apart and drops the buffer on dispose', () => {
        const { relay, frames, fire } = relayWithFakeTimers();
        relay.handleStreamEvent(messageStart('msg_a') as any);
        relay.handleStreamEvent(textDelta(0, 'a') as any);
        relay.handleStreamEvent(messageStart('msg_b') as any);
        relay.handleStreamEvent(textDelta(0, 'b') as any);
        fire();
        expect(frames.map((f) => [f.messageId, f.offset, f.delta])).toEqual([['msg_a', 0, 'a'], ['msg_b', 0, 'b']]);

        relay.handleStreamEvent(textDelta(0, 'lost') as any);
        relay.dispose();
        fire();
        expect(frames).toHaveLength(2);
    });

    it('uses real timers by default', () => {
        vi.useFakeTimers();
        try {
            const frames: StreamDeltaFrame[] = [];
            const relay = createStreamDeltaRelay({ emit: (f) => frames.push(f), flushMs: 50 });
            relay.handleStreamEvent(messageStart('msg_a') as any);
            relay.handleStreamEvent(textDelta(0, 'x') as any);
            vi.advanceTimersByTime(49);
            expect(frames).toEqual([]);
            vi.advanceTimersByTime(1);
            expect(frames).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('streamDeltaRelay — content_block_stop after an eager maxBytes flush', () => {
    it('still emits a final frame when the block was already flushed by maxBytes before content_block_stop arrives', () => {
        const { relay, frames } = relayWithFakeTimers({ maxBytes: 4 });
        relay.handleStreamEvent(messageStart('msg_a') as any);
        relay.handleStreamEvent(textDelta(0, 'abcd') as any);
        expect(frames).toEqual([{ messageId: 'msg_a', index: 0, offset: 0, delta: 'abcd', final: false }]);

        // pending is now empty for this block — content_block_stop must not be a silent no-op.
        relay.handleStreamEvent(blockStop(0) as any);

        expect(frames).toEqual([
            { messageId: 'msg_a', index: 0, offset: 0, delta: 'abcd', final: false },
            { messageId: 'msg_a', index: 0, offset: 4, delta: '', final: true },
        ]);
    });
});
