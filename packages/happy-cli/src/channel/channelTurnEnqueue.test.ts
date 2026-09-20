import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/utils/MessageQueue2';
import { enqueueChannelTurn } from './channelTurnEnqueue';

type Mode = { permissionMode: string };
const MODE: Mode = { permissionMode: 'default' };

function queue() {
    return new MessageQueue2<Mode>(mode => mode.permissionMode);
}

/** A consumer with no continuation to fold in — the ordinary case. */
const NO_CONTINUATION = { prepare: () => null };

/**
 * The real enqueue both engines use (Saycode specs/desktop-messenger-channels — R1/R5).
 *
 * Driven against a real `MessageQueue2` rather than a recorder, because the property under test
 * is what the queue does with the entry: an external request must not be folded into the turn the
 * Desktop user is composing, and the request id must survive to the consumer that gates on it.
 */
describe('enqueueChannelTurn', () => {
    it('does not fold the channel turn into whatever the Desktop user already queued', async () => {
        const q = queue();
        q.push('desktop typed this', MODE);

        enqueueChannelTurn({ text: 'from telegram', requestId: 'req-1' }, MODE, {
            queue: q,
            deferredContinuation: NO_CONTINUATION,
        });

        // The Desktop turn is still first and still alone: nothing was discarded, nothing merged.
        const first = await q.waitForMessagesAndGetAsString();
        expect(first?.message).toBe('desktop typed this');
        expect(first?.requestIds ?? []).toEqual([]);

        const second = await q.waitForMessagesAndGetAsString();
        expect(second?.message).toBe('from telegram');
        expect(second?.isolate).toBe(true);
        expect(second?.requestIds).toEqual(['req-1']);
    });

    it('keeps two channel turns apart instead of batching them into one ask', async () => {
        const q = queue();
        enqueueChannelTurn({ text: 'first', requestId: 'req-1' }, MODE, { queue: q, deferredContinuation: NO_CONTINUATION });
        enqueueChannelTurn({ text: 'second', requestId: 'req-2' }, MODE, { queue: q, deferredContinuation: NO_CONTINUATION });

        expect((await q.waitForMessagesAndGetAsString())?.requestIds).toEqual(['req-1']);
        expect((await q.waitForMessagesAndGetAsString())?.requestIds).toEqual(['req-2']);
    });

    /**
     * The id is how everything downstream knows this turn came from a channel — the consumer's
     * slash gate, the execution approval, the cancel. Losing it does not fail; it silently turns
     * the turn into ordinary local input.
     */
    it('carries the request id to the consumer', async () => {
        const q = queue();
        enqueueChannelTurn({ text: 'work', requestId: 'req-9' }, MODE, { queue: q, deferredContinuation: NO_CONTINUATION });
        expect((await q.waitForMessagesAndGetAsString())?.requestIds).toEqual(['req-9']);
    });

    it('queues the continuation text and reports it, then commits', async () => {
        const commit = vi.fn();
        const rollback = vi.fn();
        const recorded: string[] = [];
        const q = queue();

        enqueueChannelTurn({ text: 'plain', requestId: 'req-1' }, MODE, {
            queue: q,
            deferredContinuation: { prepare: () => ({ text: 'transcript + plain', commit, rollback }) },
            onDeferredText: text => recorded.push(text),
        });

        expect((await q.waitForMessagesAndGetAsString())?.message).toBe('transcript + plain');
        expect(recorded).toEqual(['transcript + plain']);
        expect(commit).toHaveBeenCalledOnce();
        expect(rollback).not.toHaveBeenCalled();
    });

    it('rolls the continuation back when the queue refuses the turn', () => {
        const commit = vi.fn();
        const rollback = vi.fn();
        const q = queue();
        q.close();

        expect(() => enqueueChannelTurn({ text: 'plain', requestId: 'req-1' }, MODE, {
            queue: q,
            deferredContinuation: { prepare: () => ({ text: 'transcript + plain', commit, rollback }) },
        })).toThrow();

        // The continuation must not be consumed by a turn that never reached the queue.
        expect(rollback).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
    });

    it('asks the continuation consumer to treat the text as channel input', () => {
        const prepare = vi.fn(() => null);
        enqueueChannelTurn({ text: '/clear', requestId: 'req-1' }, MODE, {
            queue: queue(),
            deferredContinuation: { prepare },
        });
        // Without `fromChannel`, the consumer reads `/clear` as a local reset and drops the
        // stored context — a side effect an external sender must not be able to cause.
        expect(prepare).toHaveBeenCalledWith('/clear', { fromChannel: true });
    });
});
