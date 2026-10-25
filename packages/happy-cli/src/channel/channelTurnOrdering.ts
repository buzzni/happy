import type { BackgroundTaskNotificationItem } from '@/claude/utils/OutgoingMessageQueue';
import type { EvidenceBatch } from '@/api/turnInputEvidence';
import type { InputEvidenceV1 } from '@slopus/happy-wire';
import type { SessionTurnEndStatus } from '@slopus/happy-wire';
import type { StructuredOutputEnvelope } from '@/claude/structuredOutput';

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
    inputEvidence?: EvidenceBatch;
}

export interface ChannelFinalAnswerItem {
    __channelFinalAnswer: true;
    text: string;
}

/**
 * A structured-output session's verdict on the turn (Saycode specs/claude-cli-benchmark-followups
 * R2). Ordered for the same reason as the final candidate: emitted early it finds no open turn,
 * or the previous one.
 */
export interface StructuredOutputItem {
    __structuredOutput: true;
    envelope: StructuredOutputEnvelope;
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
    | StructuredOutputItem
    | ChannelTurnEndItem
    | ChannelPermissionBindingItem;

export function pendingRequestItem(requestId: string | null, inputEvidence?: EvidenceBatch): ChannelPendingRequestItem {
    return { __channelPendingRequestId: true, requestId, ...(inputEvidence ? { inputEvidence } : {}) };
}

export function finalAnswerItem(text: string): ChannelFinalAnswerItem {
    return { __channelFinalAnswer: true, text };
}

export function structuredOutputItem(envelope: StructuredOutputEnvelope): StructuredOutputItem {
    return { __structuredOutput: true, envelope };
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
    observeClaudeBackgroundInput?(message: BackgroundTaskNotificationItem['logMessage']): void;
    setPendingInputEvidence?(batch: EvidenceBatch): void;
    continueInputEvidence?(kind: InputEvidenceV1['continuation']['kind']): void;
    sendFinalAnswerForChannelTurn(text: string): void;
    sendStructuredOutput(envelope: StructuredOutputEnvelope): void;
    closeClaudeSessionTurn(status: SessionTurnEndStatus): void;
    bindChannelPermission(permissionId: string, toolName: string, instanceSeq: number): void;
    sendClaudeSessionMessage(logMessage: unknown): void;
}

/**
 * The queue's send function. Ordinary log messages go where they always did; the markers
 * above are applied in the position they were enqueued.
 */
export function createOrderedTurnDispatcher(
    target: ChannelTurnOrderingTarget,
): (message: unknown) => void {
    return (message: unknown) => {
        if (message && typeof message === 'object' && '__claudeBackgroundNotification' in message) {
            target.observeClaudeBackgroundInput?.((message as BackgroundTaskNotificationItem).logMessage);
            return;
        }
        if (message && typeof message === 'object' && '__inputContinuation' in message) {
            target.continueInputEvidence?.((message as { __inputContinuation: InputEvidenceV1['continuation']['kind'] }).__inputContinuation);
            return;
        }
        const item = message as Partial<ChannelOrderedItem> | null;
        if (item && (item as ChannelPendingRequestItem).__channelPendingRequestId === true) {
            target.setPendingTurnRequestId((item as ChannelPendingRequestItem).requestId);
            const batch = (item as ChannelPendingRequestItem).inputEvidence;
            if (batch) target.setPendingInputEvidence?.(batch);
            return;
        }
        if (item && (item as ChannelFinalAnswerItem).__channelFinalAnswer === true) {
            target.sendFinalAnswerForChannelTurn((item as ChannelFinalAnswerItem).text);
            return;
        }
        if (item && (item as StructuredOutputItem).__structuredOutput === true) {
            target.sendStructuredOutput((item as StructuredOutputItem).envelope);
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
