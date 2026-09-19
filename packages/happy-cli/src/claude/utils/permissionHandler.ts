/**
 * Permission Handler for canCallTool integration
 *
 * Uses official SDK's toolUseID from canUseTool callback options.
 * Handles tool permission requests, responses, and state management.
 */

import {
    buildChannelApprovalObservation,
    type ChannelApprovalObservation,
    type ChannelApprovalWithdrawalReason,
} from '@/channel/channelApprovalEvent';
import {
    externalAnswerCarriesPersistentGrant,
    isExternallyAnswerableTool,
    verifyChannelPermissionClaim,
    type ChannelPermissionBinding,
} from '@/channel/channelPermissionBinding';
import { logger } from "@/lib";
import { PermissionResult } from "../sdk/types";
import { Session } from "../session";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";
import { mapToClaudeMode } from "./permissionMode";

/**
 * What the child says it did with an answer.
 *
 * Returned through the ordinary RPC path, which seals it with the session key —
 * so the browser that sent the answer can read it and nothing in between can.
 * Older clients ignore the body, which is what they did when it was `undefined`.
 */
export interface PermissionAck {
    applied: boolean;
    /** Why not, when it was not. */
    reason?: 'unknown-request' | 'already-answered';
}

interface PermissionResponse {
    id: string;
    approved: boolean;
    /**
     * Present only on an external (messenger) answer. All four identifiers must match the
     * recorded binding or the answer is refused without touching the pending request.
     */
    channelClaim?: {
        turnId?: unknown;
        channelRequestId?: unknown;
        runtimeId?: unknown;
    };
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    receivedAt?: number;
}


interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
    /**
     * Identifies this *raising* of the prompt, not the prompt id.
     *
     * Permission ids come from the provider's tool-use id and can repeat across a reset or a
     * re-run. The binding is applied asynchronously from the queue, so without this a queue item
     * from before an abort could bind a later request that happens to reuse the id.
     */
    instanceSeq: number;
}

export class PermissionHandler {
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    /**
     * permissionId -> the turn/request/runtime that raised it (Saycode T21).
     *
     * Kept beside `pendingRequests` rather than in the agent state: the state record is a public
     * DTO that reaches every client, and this is authority material for one decision. Entries are
     * removed on every path a pending request leaves by — answered, aborted, reset — so the two
     * maps cannot drift.
     */
    private channelBindings = new Map<string, ChannelPermissionBinding>();
    /** Monotonic per handler. Never reused, so a stale queue item cannot match a live request. */
    private nextInstanceSeq = 1;
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string, toolName: string, instanceSeq: number) => void;
    /** Callback to change permission mode on the active query (set by claudeRemote) */
    private setPermissionModeCallback?: (mode: PermissionMode) => Promise<void>;
    /** Publishes the sanitized lifecycle of a bound prompt. Set by the launcher. */
    private publishChannelObservation?: (observation: ChannelApprovalObservation) => void;
    private publishChannelWithdrawal?: (
        observation: ChannelApprovalObservation,
        reason: ChannelApprovalWithdrawalReason,
    ) => void;

    setChannelObservationPublisher(publish: {
        raised: (observation: ChannelApprovalObservation) => void;
        withdrawn: (
            observation: ChannelApprovalObservation,
            reason: ChannelApprovalWithdrawalReason,
        ) => void;
    }): void {
        this.publishChannelObservation = publish.raised;
        this.publishChannelWithdrawal = publish.withdrawn;
    }

    /**
     * Drops a binding and tells the external surface the prompt is gone.
     *
     * Every path a pending request leaves by goes through here. Left out of one of them, an
     * external surface keeps a live button for a prompt that no longer exists.
     */
    private withdrawChannelBinding(permissionId: string, reason: ChannelApprovalWithdrawalReason): void {
        const binding = this.channelBindings.get(permissionId);
        if (!binding) return;
        this.channelBindings.delete(permissionId);
        // Built from the binding alone, so the withdrawal names exactly what was published.
        const observation = buildChannelApprovalObservation(binding);
        if (observation) this.publishChannelWithdrawal?.(observation, reason);
    }

    /**
     * Binds a raised prompt to the turn that raised it, and publishes what an external surface
     * may know about it.
     *
     * **Called from the outgoing message queue, not from the SDK callback.** The assistant message
     * carrying the `tool_use` block is enqueued delayed and released by the prompt itself, so at
     * callback time `currentTurnId` is either null or the *previous* turn — see
     * `channel/channelTurnOrdering.ts`. The queue applies this after that message, which is the
     * first moment the turn is known.
     *
     * A prompt that has already been answered or aborted is not bound: `pendingRequests` is the
     * liveness test, and re-adding a binding for a dead prompt is how a stale entry outlives it.
     */
    bindChannelPermission(input: {
        permissionId: string;
        toolName: string;
        instanceSeq: number;
        turnId: string | null;
        channelRequestId: string | null;
        runtimeId: string;
    }): void {
        // The *exact* raising this item was enqueued for. A prompt that was aborted, answered or
        // reset — and whose id a later request reused — must not be rebound by this item.
        const pending = this.pendingRequests.get(input.permissionId);
        if (!pending || pending.instanceSeq !== input.instanceSeq) return;
        if (!input.turnId) return;
        // A tool Core cannot name is the one case with no honest classification — we can claim
        // neither that its prompt is a yes/no nor that it is not — so it is not bound at all and
        // every external answer for it is refused as an unknown prompt.
        if (typeof input.toolName !== 'string' || input.toolName.trim().length === 0) return;
        const binding: ChannelPermissionBinding = {
            permissionId: input.permissionId,
            turnId: input.turnId,
            channelRequestId: input.channelRequestId,
            runtimeId: input.runtimeId,
            // Decided once, here, where the tool name is known. A non-binary prompt is still bound
            // so the turn's wait can be published and withdrawn (R8/R9); `answerable: false` is
            // what stops it from ever being answered.
            answerable: isExternallyAnswerableTool(input.toolName),
        };
        this.channelBindings.set(input.permissionId, binding);
        // An in-app prompt is bound (so a messenger answer is refused as `not-channel-owned`) but
        // never published. `buildChannelApprovalObservation` returns null for it.
        const observation = buildChannelApprovalObservation(binding);
        if (observation) this.publishChannelObservation?.(observation);
    }

    /** What an external surface may know about a prompt. No arguments, no tool output. */
    channelBindingFor(permissionId: string): ChannelPermissionBinding | undefined {
        return this.channelBindings.get(permissionId);
    }

    constructor(session: Session) {
        this.session = session;
        this.setupClientHandler();
    }

    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string, toolName: string, instanceSeq: number) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode) {
        // Normalize here so handleToolCall's gate (which only recognizes the
        // 4 Claude-native modes) also honors Codex-style modes like 'yolo'.
        this.permissionMode = mapToClaudeMode(mode);
    }

    /**
     * Set callback to dynamically change permission mode on the active query.
     * Called by claudeRemote after the Query object is created.
     */
    setPermissionModeUpdater(callback: (mode: PermissionMode) => Promise<void>) {
        this.setPermissionModeCallback = callback;
    }

    /**
     * Handler response
     */
    private handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): void {

        // Update allowed tools
        if (response.allowTools && response.allowTools.length > 0) {
            response.allowTools.forEach(tool => {
                if (tool.startsWith('Bash(') || tool === 'Bash') {
                    this.parseBashPermission(tool);
                } else {
                    this.allowedTools.add(tool);
                }
            });
        }

        // Update permission mode
        if (response.mode) {
            this.permissionMode = response.mode;
        }

        // Handle
        if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
            logger.debug('Plan mode result received', response);
            if (response.approved) {
                // Switch permission mode via SDK before allowing ExitPlanMode
                const newMode = (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode))
                    ? response.mode
                    : 'default';

                logger.debug(`Plan approved - switching to ${newMode} mode and allowing ExitPlanMode`);

                if (this.setPermissionModeCallback) {
                    this.setPermissionModeCallback(newMode).catch((err) => {
                        logger.debug('Failed to set permission mode via SDK:', err);
                    });
                }
                this.permissionMode = newMode;

                pending.resolve({ behavior: 'allow', updatedInput: (pending.input as Record<string, unknown>) || {} });
            } else {
                pending.resolve({ behavior: 'deny', message: response.reason || 'Plan rejected' });
            }
        } else {
            // Handle default case for all other tools
            const originalInput = (pending.input as Record<string, unknown>) || {};
            const updatedInput = response.updatedInput
                ? { ...originalInput, ...response.updatedInput }
                : originalInput;
            const result: PermissionResult = response.approved
                ? { behavior: 'allow', updatedInput }
                : { behavior: 'deny', message: response.reason || `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` };

            pending.resolve(result);
        }
    }

    /**
     * Creates the canCallTool callback for the SDK.
     * Uses toolUseID from official SDK callback options directly.
     */
    handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal; toolUseID: string }): Promise<PermissionResult> => {
        const toolCallId = options.toolUseID;

        // AskUserQuestion requires user interaction — never auto-approve, even in bypassPermissions mode.
        // This mirrors Claude SDK's internal requiresUserInteraction() check.
        if (toolName === 'AskUserQuestion') {
            return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
        }

        // Check if tool is explicitly allowed
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                // Check literal matches
                if (this.allowedBashLiterals.has(inputObj.command)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
                // Check prefix matches
                for (const prefix of this.allowedBashPrefixes) {
                    if (inputObj.command.startsWith(prefix)) {
                        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                    }
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        // ExitPlanMode always requires user approval — never auto-approve it.
        if (descriptor.exitPlan) {
            return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
        }

        //
        // Handle special cases
        //

        if (this.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Plan mode: auto-approve read-only tools (Read, Glob, Grep, etc.)
        // Dangerous tools (Bash, Edit, Write) still require approval
        if (this.permissionMode === 'plan' && !descriptor.dangerous) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Approval flow
        //

        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            // Set up abort signal handling
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                this.withdrawChannelBinding(id, 'aborted');
                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            // Store the pending request
            const instanceSeq = this.nextInstanceSeq++;
            this.pendingRequests.set(id, {
                resolve: (result: PermissionResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                toolName,
                input,
                instanceSeq
            });

            // The binding is **not** recorded here. The turn this prompt belongs to has not been
            // stamped yet — the assistant message that opens it is the delayed one this callback
            // is about to release. `bindChannelPermission` is applied from the queue, after it.
            //
            // Until then no binding exists, so an external answer arriving in that window is
            // refused as `unknown-request` rather than applied to a guessed turn.
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id, toolName, instanceSeq);
            }

            // Send push notification
            this.session.api.push().sendSessionNotification({
                kind: 'permission',
                metadata: this.session.client.getMetadata(),
                data: {
                    sessionId: this.session.client.sessionId,
                    requestId: id,
                    tool: toolName,
                    type: 'permission_request',
                    provider: 'claude',
                }
            });

            // Update agent state
            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
        });
    }


    /**
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);

        if (!match) {
            return;
        }

        const command = match[1];

        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
    }

    /**
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {
        // If tool not approved, it's aborted
        if (this.responses.get(toolCallId)?.approved === false) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(reason: string = 'Session switched to local mode'): void {
        this.responses.clear();
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();
        this.permissionMode = 'default';

        // This callback closes over the Query object of the generation being torn
        // down, and claudeRemote re-registers it for every new query. Dropping it
        // keeps a dead Query from staying reachable across the restart boundary.
        // onPermissionRequestCallback is deliberately kept: it is bound to the
        // launcher-scoped message queue, not to a query, and is registered once.
        this.setPermissionModeCallback = undefined;

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();
        // Same lifetime as the requests they describe. `runtimeId` does not change across a reset
        // inside one process, so a surviving binding is not caught by the runtime check.
        for (const permissionId of [...this.channelBindings.keys()]) {
            this.withdrawChannelBinding(permissionId, 'reset');
        }

        // Move all pending requests to completedRequests with canceled status
        this.session.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    /**
     * Sets up the client handler for permission responses
     */
    /**
     * The channel answer method (Saycode specs/desktop-messenger-channels — R9).
     *
     * A **separate RPC name**, registered only by a runtime that implements the binding. That is
     * the whole point: `permission` cannot carry this guarantee, because a runtime that predates
     * T21 ignores `channelClaim` entirely and applies the answer as an ordinary one. Machine
     * capability cannot close that hole either — the session's runtime can be replaced or
     * downgraded between the moment the button is offered and the moment it is clicked, and the
     * metadata describes the machine, not the process that will receive the click.
     *
     * So an old runtime simply does not have this method, the call fails, and the caller fails
     * closed. Desktop must never retry such a refusal on `permission`.
     */
    static readonly CHANNEL_PERMISSION_METHOD = 'channel-permission';

    private setupClientHandler(): void {
        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, PermissionAck>('permission', async (message) => {
            logger.debugLargeJson('Permission response:', message);
            const id = message.id;
            const pending = this.pendingRequests.get(id);
            if (!pending) return this.missingRequestAck(id);

            /*
             * A `channelClaim` on the ordinary method is still verified, so a client that has not
             * moved to the dedicated method is no worse off than before. It is **not** the
             * fail-closed boundary: absence here means "an ordinary answer", which is exactly
             * what an old runtime would read a channel answer as.
             */
            if (message.channelClaim) {
                const refusal = this.refuseExternalAnswer(id, message);
                if (refusal) return refusal;
            }
            return this.consumeAnswer(id, message, pending);
        });

        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, PermissionAck>(
            PermissionHandler.CHANNEL_PERMISSION_METHOD,
            async (message) => {
                logger.debugLargeJson('Channel permission response:', message);
                const id = message.id;
                const pending = this.pendingRequests.get(id);
                if (!pending) return this.missingRequestAck(id);

                /*
                 * Strictly binary, and checked **before** anything is consumed. Coercing instead —
                 * `approved === true` — turns a missing or malformed field into a denial and burns
                 * the pending request on a message that was never a valid answer. The Desktop user
                 * is then left looking at a prompt that has already been decided for them.
                 */
                if (typeof message.approved !== 'boolean') {
                    logger.debug(`Channel permission answer with a non-boolean decision refused for ${id}`);
                    return { applied: false, reason: 'unknown-request' };
                }
                /*
                 * The claim is **mandatory** here, and that is the difference from `permission`:
                 * `refuseExternalAnswer` refuses a null claim, where the ordinary method reads its
                 * absence as "an ordinary Desktop answer". It also refuses any answer carrying
                 * `mode`, `allowTools`, `updatedInput` or an unrecognised `decision`, so what
                 * reaches the shared consume carries nothing but the decision.
                 */
                const refusal = this.refuseExternalAnswer(id, message);
                if (refusal) return refusal;
                return this.consumeAnswer(id, message, pending);
            },
        );
    }

    /**
     * Answered, and answered with what happened.
     *
     * This used to return nothing, which the RPC layer encrypts and returns exactly as it returns
     * a success — so a caller could not tell "the run acted on this" from "nobody was waiting for
     * it". Everything between here and the browser is a relay: the server holds no key to this
     * session and cannot inspect the answer, so the only place this fact can be stated is here,
     * inside the sealed response. Which of the two it was matters to the person: a request that
     * was already answered is a stale tab, and one nobody knows about is a prompt that has gone.
     */
    private missingRequestAck(id: string): PermissionAck {
        logger.debug('Permission request not found or already resolved');
        return this.responses.has(id)
            ? { applied: false, reason: 'already-answered' }
            : { applied: false, reason: 'unknown-request' };
    }

    /**
     * Whether an external answer may be applied. Returns the refusal, or null to proceed.
     *
     * Runs entirely **before** anything is consumed, so a refused claim leaves the prompt exactly
     * as it was for the Desktop user.
     */
    private refuseExternalAnswer(id: string, message: PermissionResponse): PermissionAck | null {
        const claim = message.channelClaim;
        // A missing claim is a refusal. The dedicated method relies on this: it is the line that
        // stops an answer with no claim from being applied as an ordinary one.
        if (!claim) {
            logger.debug(`Channel permission answer without a claim refused for ${id}`);
            return { applied: false, reason: 'unknown-request' };
        }
        if (externalAnswerCarriesPersistentGrant(message)) {
            return { applied: false, reason: 'unknown-request' };
        }
        if (typeof claim.turnId !== 'string' || typeof claim.channelRequestId !== 'string'
            || typeof claim.runtimeId !== 'string') {
            return { applied: false, reason: 'unknown-request' };
        }
        const verdict = verifyChannelPermissionClaim(this.channelBindings.get(id), {
            permissionId: id,
            turnId: claim.turnId,
            channelRequestId: claim.channelRequestId,
            runtimeId: claim.runtimeId,
        });
        if (!verdict.ok) {
            logger.debug(`Channel permission claim refused for ${id}: ${verdict.code}`);
            return { applied: false, reason: 'unknown-request' };
        }
        return null;
    }

    /**
     * Consumes the pending request. **One copy, shared by both methods**, so the Desktop race the
     * ordinary path guarantees — exactly one answer wins, and a refusal consumes nothing — holds
     * identically for a channel answer.
     */
    private consumeAnswer(
        id: string,
        message: PermissionResponse,
        pending: PendingRequest,
    ): PermissionAck {
        this.responses.set(id, { ...message, receivedAt: Date.now() });
        this.pendingRequests.delete(id);
        // Answered here or in Desktop — either way the external button is dead now.
        this.withdrawChannelBinding(id, 'answered');

        this.handlePermissionResponse(message, pending);

        this.session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;
            let r = { ...currentState.requests };
            delete r[id];
            return {
                ...currentState,
                requests: r,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: message.approved ? 'approved' : 'denied',
                        reason: message.reason,
                        mode: message.mode,
                        allowTools: message.allowTools
                    }
                }
            };
        });
        return { applied: true };
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}
