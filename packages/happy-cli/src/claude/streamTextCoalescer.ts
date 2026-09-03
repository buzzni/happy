/**
 * Coalesces SDK `stream_event` text deltas into throttled ephemeral snapshots
 * (specs/desktop-speed-breakthrough-token-streaming T1).
 *
 * The SDK's `includePartialMessages: true` option emits one event per token
 * chunk — far too fine-grained to relay individually without flooding the
 * socket. This tracks each content block's type (text deltas share their wire
 * shape with thinking deltas, so the block type must be tracked from its
 * `content_block_start`) and only lets a snapshot out once per
 * `STREAM_TEXT_COALESCE_MS` window per block.
 *
 * Pure: no I/O, no SDK types imported (the caller narrows `stream_event`
 * payloads to the shapes below), so this is testable without a live API call.
 */

export const STREAM_TEXT_COALESCE_MS = 80;

export interface StreamTextSnapshot {
    turnId: string;
    blockIndex: number;
    /** Cumulative text for the block so far — a snapshot, not a delta. */
    text: string;
}

interface ContentBlockStartEvent {
    type: 'content_block_start';
    index: number;
    content_block: { type: string };
}

interface ContentBlockDeltaEvent {
    type: 'content_block_delta';
    index: number;
    /** `BetaRawContentBlockDelta` is itself a union (text/json/citations/thinking/signature/compaction). */
    delta: { type: string; text?: string; [key: string]: unknown };
}

interface ContentBlockStopEvent {
    type: 'content_block_stop';
    index: number;
}

/** The subset of `BetaRawMessageStreamEvent` this coalescer understands. */
export type StreamTextEvent = ContentBlockStartEvent | ContentBlockDeltaEvent | ContentBlockStopEvent
    | { type: 'message_start' | 'message_delta' | 'message_stop' };

interface TrackedBlock {
    isText: boolean;
    text: string;
    /** Text carried in `text` that has not been emitted yet. */
    dirty: boolean;
    /** Seeded from the block's start time, so the first delta also waits out the window. */
    lastEmitAt: number;
}

export interface StreamTextCoalescer {
    /** Feed one stream event; returns a snapshot only when the window has elapsed. */
    push(event: StreamTextEvent, now: number): StreamTextSnapshot | null;
    /** Emits the current text for a block immediately, bypassing the window. */
    flush(index: number, now: number): StreamTextSnapshot | null;
}

export function createStreamTextCoalescer(opts: { turnId: string }): StreamTextCoalescer {
    const blocks = new Map<number, TrackedBlock>();

    function emit(index: number, block: TrackedBlock, now: number): StreamTextSnapshot | null {
        if (!block.dirty || block.text.length === 0) return null;
        block.dirty = false;
        block.lastEmitAt = now;
        return { turnId: opts.turnId, blockIndex: index, text: block.text };
    }

    return {
        push(event, now) {
            if (event.type === 'content_block_start') {
                blocks.set(event.index, {
                    isText: event.content_block.type === 'text',
                    text: '',
                    dirty: false,
                    lastEmitAt: now,
                });
                return null;
            }

            if (event.type === 'content_block_stop') {
                blocks.delete(event.index);
                return null;
            }

            if (event.type !== 'content_block_delta') return null;
            const block = blocks.get(event.index);
            if (!block || !block.isText) return null;
            if (event.delta.type !== 'text_delta' || typeof event.delta.text !== 'string') return null;

            block.text += event.delta.text;
            block.dirty = true;

            if (now - block.lastEmitAt < STREAM_TEXT_COALESCE_MS) return null;
            return emit(event.index, block, now);
        },
        flush(index, now) {
            const block = blocks.get(index);
            if (!block) return null;
            return emit(index, block, now);
        },
    };
}
