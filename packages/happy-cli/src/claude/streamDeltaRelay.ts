import type { SDKMessage } from '@/claude/sdk';

/**
 * One coalesced slice of assistant text for a (message, content block).
 * `offset` is the number of characters of this block already sent before
 * `delta`, so a consumer can accept a frame only when it continues what it
 * has (or starts a block at 0) and otherwise hide the draft instead of showing
 * a sentence with a hole in it. The persisted assistant message that follows
 * is always authoritative; frames are best-effort preview only.
 */
export type StreamDeltaFrame = {
    messageId: string;
    index: number;
    offset: number;
    delta: string;
    final: boolean;
};

type StreamEventMessage = Extract<SDKMessage, { type: 'stream_event' }>;

type PendingBlock = {
    key: string;
    messageId: string;
    index: number;
    text: string;
    final: boolean;
};

export type StreamDeltaRelay = {
    handleStreamEvent(message: StreamEventMessage): void;
    flush(): void;
    dispose(): void;
};

export const DEFAULT_STREAM_FLUSH_MS = 80;
/** Measured in UTF-16 code units (`string.length`), not encoded bytes — this
 * bounds buffered characters per flush, not wire size. */
export const DEFAULT_STREAM_MAX_BYTES = 2048;

/**
 * Projects SDK `stream_event` partials onto coalesced text frames.
 *
 * Only top-level (`parent_tool_use_id === null`) `text_delta` events are
 * relayed — subagent output never appears in the user's transcript, and
 * thinking/tool-input deltas have no rendering surface yet. A flush happens
 * `flushMs` after the first buffered delta, immediately once `maxBytes` of
 * text are pending, and immediately on `content_block_stop` (final frame).
 */
export function createStreamDeltaRelay(opts: {
    emit: (frame: StreamDeltaFrame) => void;
    flushMs?: number;
    maxBytes?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}): StreamDeltaRelay {
    const flushMs = opts.flushMs ?? DEFAULT_STREAM_FLUSH_MS;
    const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_STREAM_MAX_BYTES));
    const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    let currentMessageId: string | null = null;
    let pendingBytes = 0;
    const sentChars = new Map<string, number>();
    let timer: unknown = null;
    let disposed = false;
    const pending = new Map<string, PendingBlock>();

    const flush = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        if (pending.size === 0) return;
        const blocks = Array.from(pending.values());
        pending.clear();
        pendingBytes = 0;
        for (const block of blocks) {
            const offset = sentChars.get(block.key) ?? 0;
            if (block.final) sentChars.delete(block.key);
            else sentChars.set(block.key, offset + block.text.length);
            for (let start = 0; start < block.text.length; start += maxBytes) {
                const delta = block.text.slice(start, start + maxBytes);
                opts.emit({
                    messageId: block.messageId,
                    index: block.index,
                    offset: offset + start,
                    delta,
                    final: block.final && start + delta.length === block.text.length,
                });
            }
        }
    };

    const scheduleFlush = () => {
        if (timer !== null) return;
        timer = setTimer(() => {
            timer = null;
            flush();
        }, flushMs);
    };

    const blockKey = (messageId: string, index: number) => `${messageId}:${index}`;

    return {
        handleStreamEvent(message) {
            if (disposed) return;
            if (message.parent_tool_use_id !== null) return;
            const event = message.event as { type: string; index?: number; delta?: { type: string; text?: string }; message?: { id?: string } };
            if (event.type === 'message_start') {
                currentMessageId = typeof event.message?.id === 'string' ? event.message.id : null;
                sentChars.clear();
                return;
            }
            if (currentMessageId === null || typeof event.index !== 'number') return;
            const key = blockKey(currentMessageId, event.index);

            if (event.type === 'content_block_delta') {
                if (event.delta?.type !== 'text_delta' || typeof event.delta.text !== 'string' || event.delta.text.length === 0) return;
                const block = pending.get(key) ?? { key, messageId: currentMessageId, index: event.index, text: '', final: false };
                block.text += event.delta.text;
                pending.set(key, block);
                pendingBytes += event.delta.text.length;
                if (pendingBytes >= maxBytes) flush();
                else scheduleFlush();
                return;
            }

            if (event.type === 'content_block_stop') {
                const block = pending.get(key);
                if (block) {
                    block.final = true;
                    flush();
                    return;
                }
                // The block's text already went out via an eager maxBytes
                // flush, so `pending` is empty here — that must not swallow
                // the final=true signal a consumer relies on to stop
                // treating the block as still growing. A block that never
                // streamed any text (tool_use, thinking) has no `sentChars`
                // entry and gets no synthetic close frame.
                const alreadySent = sentChars.get(key);
                if (alreadySent === undefined) return;
                sentChars.delete(key);
                opts.emit({ messageId: currentMessageId, index: event.index, offset: alreadySent, delta: '', final: true });
            }
        },
        flush,
        dispose() {
            disposed = true;
            if (timer !== null) {
                clearTimer(timer);
                timer = null;
            }
            pending.clear();
            sentChars.clear();
            pendingBytes = 0;
        },
    };
}
