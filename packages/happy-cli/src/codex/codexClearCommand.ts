import type { QueueInputEvidence } from '@/api/turnInputEvidence';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { PendingAttachment, QueueLatencyTrace } from '@/utils/MessageQueue2';
import type { InputAttendance } from '@/api/turnAttendance';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[], requestIds?: string[], latencyTrace?: QueueLatencyTrace, attendance?: InputAttendance, evidence?: QueueInputEvidence) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[], latencyTrace?: QueueLatencyTrace, attendance?: InputAttendance, evidence?: QueueInputEvidence) => string[] | void;
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
 * Keyed on the channel handle, not on `requestIds`: those are auto-routing ids that ordinary
 * Desktop input carries too.
 *
 * Named rather than written inline at the call site so the rule is one testable decision instead
 * of a condition buried in the consumer loop.
 */
export function shouldHandleCodexClear(message: { message: string; channelRequestId?: string }): boolean {
    const fromChannel = message.channelRequestId !== undefined;
    return !fromChannel && isCodexClearText(message.message);
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    attachments?: PendingAttachment[];
    /** Routing request ids for this text, carried through to the engine boundary. */
    requestIds?: string[];
    latencyTrace?: QueueLatencyTrace;
    /** Who sent it (codexcli-approval-session-binding R10a); decides whether its turn is unattended. */
    attendance?: InputAttendance;
    evidence?: QueueInputEvidence;
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        if (opts.evidence) opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments, opts.latencyTrace, opts.attendance, opts.evidence);
        else if (opts.attendance) opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments, opts.latencyTrace, opts.attendance);
        else if (opts.latencyTrace) opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments, opts.latencyTrace);
        else opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments);
        return 'clear';
    }

    if (opts.evidence) opts.queue.push(opts.text, opts.mode, opts.attachments, opts.requestIds, opts.latencyTrace, opts.attendance, opts.evidence);
    else if (opts.attendance) opts.queue.push(opts.text, opts.mode, opts.attachments, opts.requestIds, opts.latencyTrace, opts.attendance);
    else if (opts.latencyTrace) opts.queue.push(opts.text, opts.mode, opts.attachments, opts.requestIds, opts.latencyTrace);
    else opts.queue.push(opts.text, opts.mode, opts.attachments, opts.requestIds);
    return 'queued';
}
