import type { SessionEvent } from '@slopus/happy-wire';

import {
    channelApprovalEvent,
    channelApprovalWithdrawnEvent,
    type ChannelApprovalObservation,
    type ChannelApprovalWithdrawalReason,
} from '@/channel/channelApprovalEvent';
import { permissionBindingItem } from '@/channel/channelTurnOrdering';

/**
 * Connects a permission prompt to the turn that raised it, through the outgoing queue
 * (Saycode specs/desktop-messenger-channels — R9/R14).
 *
 * Exists as its own function so the launcher and its tests run the same code — reconstructed in a
 * test, the two drift and the test stops saying anything about production.
 *
 * **The turn is resolved by tool-call membership, not by "what is current".** The SDK reads the
 * assistant message and the permission `control_request` off one transport loop but puts them on
 * different paths: `handleControlRequest` is dispatched without being awaited, and the message goes
 * to a separate input stream our own loop drains. So either can be observed first, and no enqueue
 * order here can change that — an ordering argument based on queue ids would be claiming a
 * guarantee the upstream does not give.
 *
 * `bindChannelPermissionWhenKnown` therefore waits for the turn that *contains this tool call*,
 * and whichever of the two facts arrives second triggers the bind. Until then nothing is bound,
 * which is the fail-closed direction: an answer arriving early is refused as `unknown-request`.
 *
 * The queue item is still used, so the bind is requested in transcript order relative to the other
 * three markers; it just no longer carries the correctness argument on its own.
 */
export interface ChannelPermissionQueue {
    enqueue(message: unknown): void;
    releaseToolCall(toolCallId: string): Promise<void> | void;
}

export interface ChannelPermissionBindingSink {
    setOnPermissionRequest(
        callback: (toolCallId: string, toolName: string, instanceSeq: number) => void,
    ): void;
    setChannelObservationPublisher(publish: {
        raised: (observation: ChannelApprovalObservation) => void;
        withdrawn: (
            observation: ChannelApprovalObservation,
            reason: ChannelApprovalWithdrawalReason,
        ) => void;
    }): void;
    bindChannelPermission(input: {
        permissionId: string;
        toolName: string;
        instanceSeq: number;
        turnId: string | null;
        channelRequestId: string | null;
        runtimeId: string;
    }): void;
}

export interface ChannelPermissionWiringDeps {
    queue: ChannelPermissionQueue;
    handler: ChannelPermissionBindingSink;
    /**
     * Resolves the turn that contains `toolCallId`, calling `apply` once it is known — now, or
     * when the mapper stamps its `tool-call-start`, whichever is second.
     */
    turnContextFor(
        toolCallId: string,
        apply: (context: { turnId: string; channelRequestId: string | null; runtimeId: string }) => void,
    ): void;
    /** Sends a sanitized lifecycle event. Identity only. */
    publish(event: SessionEvent): void;
    now?(): number;
}

/**
 * Installs the callbacks and returns the ordering target's `bindChannelPermission`.
 *
 * The return value is what the dispatcher calls; the side effects are the two handler callbacks.
 * Splitting them would let a caller install one and forget the other, which fails silently — the
 * prompt is never bound and every messenger answer is refused as `unknown-request`.
 */
export function installChannelPermissionWiring(
    deps: ChannelPermissionWiringDeps,
): (permissionId: string, toolName: string, instanceSeq: number) => void {
    const now = deps.now ?? Date.now;
    deps.handler.setChannelObservationPublisher({
        raised: (observation) => { deps.publish(channelApprovalEvent(observation, now())); },
        withdrawn: (observation, reason) => {
            deps.publish(channelApprovalWithdrawnEvent(observation, reason, now()));
        },
    });
    deps.handler.setOnPermissionRequest((toolCallId, toolName, instanceSeq) => {
        deps.queue.enqueue(permissionBindingItem(toolCallId, toolName, instanceSeq));
        void deps.queue.releaseToolCall(toolCallId);
    });
    return (permissionId, toolName, instanceSeq) => {
        deps.turnContextFor(permissionId, (context) => {
            // `instanceSeq` is carried through the wait, so a prompt that was aborted or answered
            // before its turn was mapped is not bound when the membership finally appears.
            deps.handler.bindChannelPermission({
                permissionId,
                toolName,
                instanceSeq,
                turnId: context.turnId,
                channelRequestId: context.channelRequestId,
                runtimeId: context.runtimeId,
            });
        });
    };
}
