import type { PendingAttachment } from '@/utils/MessageQueue2';

/** Structural copy of the deferred-continuation consumer's prepared turn. */
type PreparedTurn = { text: string; commit: () => void; rollback: () => void };

export interface ChannelTurnEnqueueDeps<T> {
    queue: {
        pushIsolated(
            message: string,
            mode: T,
            attachments?: PendingAttachment[],
            requestIds?: string[],
            channelRequestId?: string,
        ): void;
    };
    deferredContinuation: {
        prepare(text: string, options?: { fromChannel?: boolean }): PreparedTurn | null;
    };
    /**
     * Claude records the app-visible prompt when a continuation is folded in, so the row the
     * person sees stays the text they wrote. Codex has no such row and passes nothing.
     */
    onDeferredText?: (text: string) => void;
}

/**
 * Put an accepted channel turn on the queue (Saycode specs/desktop-messenger-channels — R1/R5).
 *
 * **Isolated, never `push`.** Batching would fold an external request together with whatever the
 * Desktop user was typing — one turn, two askers. It still preserves everything already queued,
 * unlike `pushIsolateAndClear`. The insert also wakes a local-mode session: the queue's
 * `onMessage` handler asks local Claude to hand control back so remote mode can take this turn.
 *
 * **The request id rides along.** Everything downstream — the consumer's slash gate, the
 * execution approval, the cancel — identifies a channel turn by it. Dropping it here does not
 * fail; it silently turns the turn into ordinary local input.
 *
 * Written once for both engines because both had the same body, and because the real one was
 * previously unreachable from a test: it lives in a closure that `ChannelPromptAcceptance`
 * receives as an injected dep, and every test replaced it with a recorder.
 */
export function enqueueChannelTurn<T>(
    input: { text: string; requestId: string },
    /**
     * Read at the push, not before it. Both engines build the mode from live session state that
     * the continuation prepare and the prompt record above can still move; taking it as a value
     * at the call site would freeze a mode from before those ran.
     */
    mode: () => T,
    deps: ChannelTurnEnqueueDeps<T>,
): void {
    const deferredTurn = deps.deferredContinuation.prepare(input.text, { fromChannel: true });
    const queuedText = deferredTurn?.text ?? input.text;
    try {
        if (deferredTurn) deps.onDeferredText?.(queuedText);
        deps.queue.pushIsolated(queuedText, mode(), [], undefined, input.requestId);
        deferredTurn?.commit();
    } catch (error) {
        // The continuation must not be consumed by a turn that never reached the queue.
        deferredTurn?.rollback();
        throw error;
    }
}
