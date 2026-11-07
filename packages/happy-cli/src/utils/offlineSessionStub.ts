/**
 * Offline Session Stub Factory
 *
 * Creates a no-op session stub for offline mode that can be used across all backends
 * (Claude, Codex, Gemini, etc.). All session methods become no-ops until reconnection.
 *
 * This follows DRY principles by providing a single implementation for all backends,
 * satisfying REQ-8 from serverConnectionErrors.ts.
 *
 * @module offlineSessionStub
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TurnInputEvidence, type EvidenceBatch } from '@/api/turnInputEvidence';
import type { ApiSessionClient } from '@/api/apiSession';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

type RpcRegistration = {
    handler: Parameters<RpcHandlerManager['registerHandler']>[1];
    policy: Parameters<RpcHandlerManager['registerHandler']>[2];
};

/** Handlers a runner registered on the stub; the last registration per target wins, as on a real session. */
type OfflineRegistrations = {
    userMessageHandler: Parameters<ApiSessionClient['onUserMessage']>[0] | null;
    fileEventHandler: Parameters<ApiSessionClient['onFileEvent']>[0] | null;
    rpcHandlers: Map<string, RpcRegistration>;
};

const offlineRegistrations = new WeakMap<object, OfflineRegistrations>();

/**
 * Creates a no-op session stub for offline mode.
 *
 * The stub is a real EventEmitter (so `session.on('archived', ...)` and friends
 * are safe to call before reconnection) with no-op implementations of every
 * ApiSessionClient method the runners touch before a session swap. When
 * reconnection succeeds, the real session replaces this stub.
 *
 * Runners register their user-message, file-event and RPC handlers once, on
 * whatever session they hold at startup. The stub records those so
 * `transferOfflineRegistrations` can attach them to the real session.
 *
 * @param sessionTag - Unique session tag (used to create offline session ID)
 * @returns A no-op ApiSessionClient stub
 *
 * @example
 * ```typescript
 * const offlineStub = createOfflineSessionStub(sessionTag);
 * let session: ApiSessionClient = offlineStub;
 *
 * // When reconnected:
 * session = api.sessionSyncClient(response);
 * ```
 */
export function createOfflineSessionStub(sessionTag: string): ApiSessionClient {
    const stub = new EventEmitter();
    const registrations: OfflineRegistrations = { userMessageHandler: null, fileEventHandler: null, rpcHandlers: new Map() };
    offlineRegistrations.set(stub, registrations);
    const inputEvidence = new TurnInputEvidence(randomUUID(), () => {});
    return Object.assign(stub, {
        sessionId: `offline-${sessionTag}`,
        // Offline input is unwitnessed: never advertise capability or publish a fabricated receipt.
        inputEvidence,
        configureInputQueue: () => {},
        setInputMode: () => {},
        setInputSteerAvailable: () => {},
        setPendingInputEvidence: (batch: EvidenceBatch | null) => inputEvidence.setPending(batch),
        startClaudeInputEvidence: () => {},
        continueClaudeInputEvidence: () => {},
        recordPermissionInput: () => () => {},
        sendCodexMessage: () => {},
        sendAgentMessage: () => {},
        sendClaudeSessionMessage: () => {},
        sendProviderUsageEvent: () => {},
        sendSessionProtocolMessage: () => {},
        keepAlive: () => {},
        // No runtime report leaves the stub; after the swap the next sub-agent list marks the real session.
        markLaunchedBackgroundJob: () => {},
        sendSessionEvent: () => {},
        sendSessionDeath: () => {},
        updateLifecycleState: () => {},
        requestControlTransfer: async () => {},
        flush: async () => {},
        close: async () => {},
        updateMetadata: () => {},
        updateAgentState: () => {},
        getMetadata: () => null,
        onUserMessage: (handler: OfflineRegistrations['userMessageHandler']) => {
            registrations.userMessageHandler = handler;
        },
        onFileEvent: (handler: OfflineRegistrations['fileEventHandler']) => {
            registrations.fileEventHandler = handler;
        },
        skipExistingMessages: () => {},
        capRuntimeProcessedSeq: () => {},
        suppressNextArchiveSignal: () => {},
        trackAttachmentDownload: () => {},
        drainAttachmentsForUserMessage: async () => [],
        // Must produce a SessionEnvelope — impossible offline, so throw; the
        // only caller (codex fork backfill) wraps the call in try/catch.
        uploadLocalImageAttachmentEnvelope: async () => { throw new Error('Session is offline: attachments unavailable'); },
        rpcHandlerManager: {
            registerHandler: (method: string, handler: RpcRegistration['handler'], policy?: RpcRegistration['policy']) => {
                registrations.rpcHandlers.set(method, { handler, policy });
            }
        }
    }) as unknown as ApiSessionClient;
}

/**
 * Attaches the handlers registered on an offline stub to the real session that
 * replaces it after reconnection, then forgets them. Without this the real
 * session has no user-message listener and no RPC handlers (abort, killSession,
 * side-question, ...), so the app's messages and commands are ignored.
 *
 * RPC handlers go first: the real `onUserMessage` delivers already-queued
 * messages at once, and handling one may need them.
 */
export function transferOfflineRegistrations(stub: ApiSessionClient, session: ApiSessionClient): void {
    const registrations = offlineRegistrations.get(stub);
    if (!registrations) return;
    const { userMessageHandler, fileEventHandler } = registrations;
    const rpcHandlers = [...registrations.rpcHandlers];
    registrations.userMessageHandler = null;
    registrations.fileEventHandler = null;
    registrations.rpcHandlers.clear();
    for (const [method, { handler, policy }] of rpcHandlers) {
        session.rpcHandlerManager.registerHandler(method, handler, policy);
    }
    if (fileEventHandler) session.onFileEvent(fileEventHandler);
    if (userMessageHandler) session.onUserMessage(userMessageHandler);
}
