import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

/**
 * Whether a dequeued message may be handled as Codex session control.
 *
 * Relayed channel text never may. A channel turn reaches the queue through the session's own RPC
 * and so never passes the enqueue-side parser, but it does arrive at the consumer — where `/clear`
 * wipes the Codex thread state. Gating only the enqueue side would leave an external sender able
 * to reset a session's context with seven characters
 * (Saycode specs/desktop-messenger-channels — R1/R5).
 *
 * Named rather than written inline at the call site so the rule is one testable decision instead
 * of a condition buried in the consumer loop.
 */
export function shouldHandleCodexClear(message: { message: string; requestIds?: readonly string[] }): boolean {
    const fromChannel = (message.requestIds?.length ?? 0) > 0;
    return !fromChannel && isCodexClearText(message.message);
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    attachments?: PendingAttachment[];
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments);
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode, opts.attachments);
    return 'queued';
}
