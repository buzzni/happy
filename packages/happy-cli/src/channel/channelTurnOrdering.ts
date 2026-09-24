import type { SessionTurnEndStatus } from '@slopus/happy-wire';

/**
 * Keeping a turn's boundary events in the same order as its transcript
 * (Saycode specs/desktop-messenger-channels — R8/R14).
 *
 * `OutgoingMessageQueue` delivers inside an async lock, so anything the launcher calls directly
 * from an SDK callback runs *before* the assistant logs already sitting in that queue. Three
 * things must not do that:
 *
 * - **The correlation id**, set when a batch becomes the running turn. Assigned early, it would
 *   overwrite the previous turn's pending id before that turn's own terminal had been emitted,
 *   and the previous request would be answered under the next request's id.
 * - **The final candidate**, emitted on the SDK result. Emitted early it finds no open turn — the
 *   assistant log that opens one is still queued — and is dropped.
 * - **The terminal**, emitted on ready. Emitted early it closes a turn that has not received its
 *   text yet, so the later flush opens a second, unrelated turn.
 * - **The permission binding**, recorded when a prompt is raised. This one is the sharpest: the
 *   assistant message carrying the `tool_use` block is enqueued *delayed* and released by the
 *   prompt itself, so at callback time the turn it belongs to has not been stamped yet.
 *   `currentTurnId` is then either null (first turn of the query) or the **previous** turn — and a
 *   binding recorded against the previous turn accepts an answer aimed at it while refusing the
 *   right one. Enqueued, it carries a later id than that message and so is applied after it.
 *
 * Routing all four through the same queue is what makes `turn-start → text → final-answer →
 * turn-end` hold. This module owns the item shapes and the dispatcher so the launcher and its
 * tests run the same code rather than two similar ones.
 */

export interface ChannelPendingRequestItem {
    __channelPendingRequestId: true;
    requestId: string | null;
}

export interface ChannelFinalAnswerItem {
    __channelFinalAnswer: true;
    text: string;
}

export interface ChannelTurnEndItem {
    __channelTurnEnd: true;
    status: SessionTurnEndStatus;
}

export interface ChannelPermissionBindingItem {
    __channelPermissionBinding: true;
    permissionId: string;
    /** Kept for the binary-tool gate inside the runtime; never published. */
    toolName: string;
    /** The exact raising this item was enqueued for — see `PermissionHandler.instanceSeq`. */
    instanceSeq: number;
}

export type ChannelOrderedItem =
    | ChannelPendingRequestItem
    | ChannelFinalAnswerItem
    | ChannelTurnEndItem
    | ChannelPermissionBindingItem;

export function pendingRequestItem(requestId: string | null): ChannelPendingRequestItem {
    return { __channelPendingRequestId: true, requestId };
}

export function finalAnswerItem(text: string): ChannelFinalAnswerItem {
    return { __channelFinalAnswer: true, text };
}

export function turnEndItem(status: SessionTurnEndStatus): ChannelTurnEndItem {
    return { __channelTurnEnd: true, status };
}

export function permissionBindingItem(
    permissionId: string,
    toolName: string,
    instanceSeq: number,
): ChannelPermissionBindingItem {
    return { __channelPermissionBinding: true, permissionId, toolName, instanceSeq };
}

/** The subset of the session client these ordered items act on. */
export interface ChannelTurnOrderingTarget {
    setPendingTurnRequestId(requestId: string | null): void;
    sendFinalAnswerForChannelTurn(text: string): void;
    closeClaudeSessionTurn(status: SessionTurnEndStatus): void;
    bindChannelPermission(permissionId: string, toolName: string, instanceSeq: number): void;
    sendClaudeSessionMessage(logMessage: unknown): void;
}

/**
 * The queue's send function. Ordinary log messages go where they always did; the four markers
 * above are applied in the position they were enqueued.
 */
export function createOrderedTurnDispatcher(
    target: ChannelTurnOrderingTarget,
): (message: unknown) => void {
    return (message: unknown) => {
        const item = message as Partial<ChannelOrderedItem> | null;
        if (item && (item as ChannelPendingRequestItem).__channelPendingRequestId === true) {
            target.setPendingTurnRequestId((item as ChannelPendingRequestItem).requestId);
            return;
        }
        if (item && (item as ChannelFinalAnswerItem).__channelFinalAnswer === true) {
            target.sendFinalAnswerForChannelTurn((item as ChannelFinalAnswerItem).text);
            return;
        }
        if (item && (item as ChannelTurnEndItem).__channelTurnEnd === true) {
            target.closeClaudeSessionTurn((item as ChannelTurnEndItem).status);
            return;
        }
        if (item && (item as ChannelPermissionBindingItem).__channelPermissionBinding === true) {
            const binding = item as ChannelPermissionBindingItem;
            target.bindChannelPermission(binding.permissionId, binding.toolName, binding.instanceSeq);
            return;
        }
        target.sendClaudeSessionMessage(message);
    };
}
