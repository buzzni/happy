/**
 * Coalesces SDK `stream_event` text deltas into throttled ephemeral chunks
 * (specs/desktop-speed-breakthrough-token-streaming T1).
 *
 * The SDK's `includePartialMessages: true` option emits one event per token
 * chunk — far too fine-grained to relay individually without flooding the
 * socket. This tracks each content block's type (text deltas share their wire
 * shape with thinking deltas, so the block type must be tracked from its
 * `content_block_start`) and only lets chunks out once per
 * `STREAM_TEXT_COALESCE_MS` window per block. Chunks carry a monotonic sequence
 * so a receiver can reject an incomplete preview after a volatile packet loss.
 *
 * Pure: no I/O, no SDK types imported (the caller narrows `stream_event`
 * payloads to the shapes below), so this is testable without a live API call.
 */

export const STREAM_TEXT_COALESCE_MS = 80;
export const STREAM_TEXT_MAX_CHUNK_CHARS = 16 * 1024;

export interface StreamTextChunk {
    turnId: string;
    blockIndex: number;
    sequence: number;
    /** Incremental text since the previous chunk. */
    delta: string;
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
    pendingText: string;
    nextSequence: number;
    /** Seeded from the block's start time, so the first delta also waits out the window. */
    lastEmitAt: number;
}

export interface StreamTextCoalescer {
    /** Feed one stream event; returns chunks only when the window has elapsed. */
    push(event: StreamTextEvent, now: number): StreamTextChunk[];
    /** Emits pending text for a block immediately, bypassing the window. */
    flush(index: number, now: number): StreamTextChunk[];
}

export function createStreamTextCoalescer(opts: { turnId: string }): StreamTextCoalescer {
    const blocks = new Map<number, TrackedBlock>();

    function emit(index: number, block: TrackedBlock, now: number): StreamTextChunk[] {
        if (block.pendingText.length === 0) return [];
        const chunks: StreamTextChunk[] = [];
        while (block.pendingText.length > 0) {
            const delta = block.pendingText.slice(0, STREAM_TEXT_MAX_CHUNK_CHARS);
            block.pendingText = block.pendingText.slice(delta.length);
            chunks.push({
                turnId: opts.turnId,
                blockIndex: index,
                sequence: block.nextSequence,
                delta,
            });
            block.nextSequence += 1;
        }
        block.lastEmitAt = now;
        return chunks;
    }

    return {
        push(event, now) {
            if (event.type === 'content_block_start') {
                blocks.set(event.index, {
                    isText: event.content_block.type === 'text',
                    pendingText: '',
                    nextSequence: 0,
                    lastEmitAt: now,
                });
                return [];
            }

            if (event.type === 'content_block_stop') {
                blocks.delete(event.index);
                return [];
            }

            if (event.type !== 'content_block_delta') return [];
            const block = blocks.get(event.index);
            if (!block || !block.isText) return [];
            if (event.delta.type !== 'text_delta' || typeof event.delta.text !== 'string') return [];

            block.pendingText += event.delta.text;

            if (now - block.lastEmitAt < STREAM_TEXT_COALESCE_MS) return [];
            return emit(event.index, block, now);
        },
        flush(index, now) {
            const block = blocks.get(index);
            if (!block) return [];
            return emit(index, block, now);
        },
    };
}
