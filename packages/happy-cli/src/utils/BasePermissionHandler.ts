/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AgentState } from "@/api/types";
import type { PermissionPolicyMeta } from '@/toolPolicy/policyGate';
import { ResolvedPermissionLog, type PermissionAck, type PermissionResolution } from '@/utils/permissionResolution';

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    updatedInput?: Record<string, unknown>;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    /** Tool policy (agent-tool-policy R11.3): "allow in this conversation". Older clients omit it. */
    policyGrant?: 'once' | 'session';
}

/**
 * Pending permission request stored while awaiting user response.
 */
export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Result of a permission request.
 */
export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    updatedInput?: Record<string, unknown>;
    policyGrant?: 'session';
}

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
/** Which path a pending request left by. */
export type PendingSettlementReason = 'answered' | 'aborted' | 'reset';

export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected session: ApiSessionClient;
    private isResetting = false;
    /** Settled ids, kept across `reset()` so a late answer is told what happened (plan §3.4, T16). */
    private readonly resolved = new ResolvedPermissionLog();

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    /**
     * A pending request left the map. Optional, and a no-op unless a subclass wants it.
     *
     * Exists so a subclass that publishes something about a waiting prompt can retract it on every
     * path the prompt leaves by — answered, aborted, reset — without duplicating the settlement
     * logic each of those paths already owns (Saycode specs/desktop-messenger-channels R8).
     *
     * Never called before the request has been removed and resolved, so an implementation cannot
     * observe a half-settled request, and never in a way that can affect that settlement: see
     * `notifySettled`. Subclasses that do not override it — Gemini, the ACP handler — are
     * unaffected and gain no channel behaviour.
     */
    protected onPendingSettled?(permissionId: string, reason: PendingSettlementReason): void;

    /**
     * Calls the hook and swallows whatever it does.
     *
     * A publisher that throws must not turn an answered permission into an unanswered one, or stop
     * an abort or a reset partway through — the prompt is already resolved by the time this runs,
     * and the caller has nothing left it could roll back. The diagnostic is a fixed string: the
     * failure came from a channel publisher whose error may carry provider text, and this log is
     * not a place to put that.
     */
    private notifySettled(permissionId: string, reason: PendingSettlementReason): void {
        if (!this.onPendingSettled) return;
        try {
            this.onPendingSettled(permissionId, reason);
        } catch {
            logger.debug(`${this.getLogPrefix()} settlement notification failed for ${permissionId}`);
        }
    }


    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
    }

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        // Returns what happened to the answer, as the Claude handler does (T17). Clients that predate
        // the body ignore it, which is what they did with `undefined`.
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, PermissionAck>(
            'permission',
            async (response) => {
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug(`${this.getLogPrefix()} Permission request not found or already resolved`);
                    return this.resolved.ackFor(response.id);
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);
                this.resolved.record(response.id, 'answered');

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                if (response.approved && response.updatedInput && typeof response.updatedInput === 'object' && !Array.isArray(response.updatedInput)) {
                    result.updatedInput = response.updatedInput;
                }
                if (response.approved && response.policyGrant === 'session') result.policyGrant = 'session';
                pending.resolve(result);
                // After the request is gone and resolved, so a throwing subscriber cannot turn an
                // answered permission into an unanswered one.
                this.notifySettled(response.id, 'answered');

                // Move request to completed in agent state
                const completedAt = Date.now();
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    let res = {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt,
                                status: response.approved ? 'approved' : 'denied',
                                decision: result.decision,
                                resolution: 'answered',
                            }
                        }
                    } satisfies AgentState;
                    return res;
                });

                logger.debug(`${this.getLogPrefix()} Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
                return { applied: true };
            }
        );
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown, policy?: PermissionPolicyMeta): void {
        const createdAt = Date.now();
        this.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [toolCallId]: {
                    tool: toolName,
                    arguments: input,
                    createdAt,
                    ...(policy ? { policy } : {}),
                }
            }
        }));
    }

    /** Cancel only this provider-owned request; unrelated approvals remain pending. */
    cancelRequest(id: string, resolution: PermissionResolution = 'aborted'): void {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        this.resolved.record(id, resolution);
        pending.resolve({ decision: 'abort' });
        this.notifySettled(id, 'aborted');
        const completedAt = Date.now();
        this.session.updateAgentState(current => {
            const request = current.requests?.[id];
            if (!request) return current;
            const { [id]: _, ...requests } = current.requests ?? {};
            return { ...current, requests, completedRequests: {
                ...current.completedRequests, [id]: { ...request, completedAt, status: 'canceled', resolution },
            } };
        });
    }

    /**
     * Abort all pending permission requests.
     * Unlike reset(), this resolves (not rejects) pending promises with { decision: 'abort' },
     * causing the approval response to send 'cancel' to the provider. This is used when the
     * user presses the abort/stop button — it unblocks any pending tool approval so the provider
     * can process the turn cancellation.
     */
    abortAll(reason: string = 'Aborted by user', resolution: PermissionResolution = 'aborted'): void {
        const pendingSnapshot = Array.from(this.pendingRequests.entries());
        if (pendingSnapshot.length === 0) return;

        this.pendingRequests.clear();

        for (const [id, pending] of pendingSnapshot) {
            this.resolved.record(id, resolution);
            try {
                pending.resolve({ decision: 'abort' });
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error resolving aborted request ${id}:`, err);
            }
            // Per request and after its own resolve, so one throwing subscriber cannot stop the
            // rest of the abort.
            this.notifySettled(id, 'aborted');
        }

        // Move pending requests to completed as canceled in agent state
        const completedAt = Date.now();
        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt,
                    status: 'canceled',
                    reason,
                    resolution,
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });

        logger.debug(`${this.getLogPrefix()} Aborted ${pendingSnapshot.length} pending permission(s)`);
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(reason: string = 'Session reset', resolution: PermissionResolution = 'reset'): void {
        // Guard against re-entrant/concurrent resets
        if (this.isResetting) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, skipping`);
            return;
        }
        this.isResetting = true;

        try {
            // Snapshot pending requests to avoid Map mutation during iteration
            const pendingSnapshot = Array.from(this.pendingRequests.entries());
            this.pendingRequests.clear(); // Clear immediately to prevent new entries being processed

            // Reject all pending requests from snapshot
            for (const [id, pending] of pendingSnapshot) {
                this.resolved.record(id, resolution);
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending request ${id}:`, err);
                }
                // Per request and after its own reject, so one throwing subscriber cannot leave the
                // rest of the reset half-done.
                this.notifySettled(id, 'reset');
            }

            // Clear requests in agent state
            const completedAt = Date.now();
            this.session.updateAgentState((currentState) => {
                const pendingRequests = currentState.requests || {};
                const completedRequests = { ...currentState.completedRequests };

                // Move all pending to completed as canceled
                for (const [id, request] of Object.entries(pendingRequests)) {
                    completedRequests[id] = {
                        ...request,
                        completedAt,
                        status: 'canceled',
                        reason,
                        resolution,
                    };
                }

                return {
                    ...currentState,
                    requests: {},
                    completedRequests
                };
            });

            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
