/**
 * What a Codex approval request means, and who answers it
 * (Saycode specs/desktop-messenger-channels — R8/R9).
 *
 * The whole server→client approval boundary lives here rather than inline in `runCodex` because
 * the part of it that was wrong could not be reached by a test: the guidance below was published
 * from the call site, before the pending request existed, and every publish was silently dropped
 * while handler-level tests passed. `installCodexApprovalBoundary` is what the real run installs,
 * so a test drives the same code an app-server request reaches.
 *
 * ---
 *
 * Whether a Codex approval request may be attributed to a channel turn
 * (Saycode specs/desktop-messenger-channels — R8/R9).
 *
 * One place owns this decision because the call site got it wrong: the boundary in `runCodex`
 * published guidance before the pending request existed, and looked the turn up by whichever turn
 * was currently open. Both are attribution questions, not permission questions, so they belong
 * together and away from the handler that merely carries the answer.
 *
 * Every refusal here means **no guidance is published at all**. That is the intended outcome, not a
 * degraded one: guidance names a waiting turn to a messenger, and naming the wrong turn tells
 * someone their message is blocked when it is not — or worse, tells them nothing is waiting.
 *
 * Attribution requires, with no fallback for any of them:
 *
 * - **The request's own provider turn id.** Not the open turn: an approval can arrive for work
 *   started by an earlier request.
 * - **The request's own thread id, equal to the one this run actually started or resumed.** A
 *   non-null foreign thread is refused even when its turn id matches ours, because provider turn
 *   ids are only unique within a thread and a collision would attribute another conversation's
 *   wait to this session.
 * - **An open protocol turn for that provider turn**, via the mapper's own native→protocol map.
 *
 * A server that supplies neither id is explicitly unsupported for guidance. Ordinary Desktop
 * approval is unaffected either way — it never consults this.
 */

import { logger } from '@/ui/logger';

import { codexProtocolTurnFor, type CodexTurnState } from './sessionProtocolMapper';

/** What the approval request itself carried. Absent stays absent. */
export interface CodexApprovalIdentity {
    turnId?: string | null;
    threadId?: string | null;
}

export interface CodexApprovalChannelTurn {
    turnId: string;
    channelRequestId: string | null;
    runtimeId: string;
}

export function codexApprovalChannelTurn(input: {
    approval: CodexApprovalIdentity;
    /** The thread this run started or resumed — `client.threadId`, not anything a request claims. */
    runThreadId: string | null;
    turnState: Pick<CodexTurnState, 'currentTurnId' | 'currentRequestId' | 'providerTurnToProtocol'>;
    runtimeId: string;
}): CodexApprovalChannelTurn | null {
    const { approval, runThreadId, turnState, runtimeId } = input;
    const threadId = approval.threadId ?? null;
    // Both required. A request that named only its turn cannot be checked against this run's
    // conversation, and this run with no thread of its own has nothing to check against.
    if (!threadId || !runThreadId) return null;
    if (threadId !== runThreadId) return null;
    const observed = codexProtocolTurnFor(turnState, approval.turnId ?? null);
    if (!observed) return null;
    return { turnId: observed.turnId, channelRequestId: observed.requestId, runtimeId };
}

/** Just the approval-facing slice of the client and handler, so a test needs neither whole. */
export interface CodexApprovalBoundaryOptions {
    client: {
        setApprovalHandler(handler: (params: CodexApprovalRequest) => Promise<ReviewDecision>): void;
        /** Read per request: the run adopts its thread after the handler is installed. */
        readonly threadId: string | null;
    };
    permissionHandler: {
        handleToolCall(
            callId: string,
            toolName: string,
            input: unknown,
            context?: {
                serverName?: string;
                channelTurn?: CodexApprovalChannelTurn;
            },
        ): Promise<{ decision: ReviewDecision }>;
    };
    /** Read per request: the open turn and request move as the run proceeds. */
    turnState(): Pick<CodexTurnState, 'currentTurnId' | 'currentRequestId' | 'providerTurnToProtocol'>;
    runtimeId: string;
    /** True for a call into a broker this run registered itself — nothing to ask a person. */
    isAutoApproved(params: CodexApprovalRequest): boolean;
}

export type ReviewDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

export interface CodexApprovalRequest extends CodexApprovalIdentity {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    command?: string[];
    cwd?: string;
    fileChanges?: unknown;
    toolName?: string;
    input?: unknown;
    serverName?: string;
}

/** The tool identity Desktop and the permission handler already know these requests by. */
export function codexApprovalToolCall(params: CodexApprovalRequest): { toolName: string; input: unknown } {
    if (params.type === 'exec') {
        return { toolName: 'CodexBash', input: { command: params.command, cwd: params.cwd } };
    }
    if (params.type === 'patch') {
        return { toolName: 'CodexPatch', input: { changes: params.fileChanges } };
    }
    return { toolName: params.toolName ?? 'McpTool', input: params.input ?? {} };
}

export function installCodexApprovalBoundary(options: CodexApprovalBoundaryOptions): void {
    const { client, permissionHandler, runtimeId } = options;
    client.setApprovalHandler(async (params) => {
        if (options.isAutoApproved(params)) return 'approved';
        const { toolName, input } = codexApprovalToolCall(params);
        /*
         * Guidance is attributed here and carried into `handleToolCall`, which publishes it once
         * the pending request exists. Nothing is published from this function, so there is no
         * ordering for a caller to get wrong. Codex approvals are never externally answerable;
         * this is guidance only, and a refusal to attribute means silence.
         */
        const channelTurn = codexApprovalChannelTurn({
            approval: { turnId: params.turnId, threadId: params.threadId },
            runThreadId: client.threadId,
            turnState: options.turnState(),
            runtimeId,
        });
        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input, {
                ...(params.serverName !== undefined ? { serverName: params.serverName } : {}),
                ...(channelTurn ? { channelTurn } : {}),
            });
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });
}
