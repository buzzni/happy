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

/**
 * Creates a no-op session stub for offline mode.
 *
 * The stub is a real EventEmitter (so `session.on('archived', ...)` and friends
 * are safe to call before reconnection) with no-op implementations of every
 * ApiSessionClient method the runners touch before a session swap. When
 * reconnection succeeds, the real session replaces this stub.
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
        sendSessionEvent: () => {},
        sendSessionDeath: () => {},
        updateLifecycleState: () => {},
        requestControlTransfer: async () => {},
        flush: async () => {},
        close: async () => {},
        updateMetadata: () => {},
        updateAgentState: () => {},
        getMetadata: () => null,
        onUserMessage: () => {},
        onFileEvent: () => {},
        skipExistingMessages: () => {},
        capRuntimeProcessedSeq: () => {},
        suppressNextArchiveSignal: () => {},
        trackAttachmentDownload: () => {},
        drainAttachmentsForUserMessage: async () => [],
        // Must produce a SessionEnvelope — impossible offline, so throw; the
        // only caller (codex fork backfill) wraps the call in try/catch.
        uploadLocalImageAttachmentEnvelope: async () => { throw new Error('Session is offline: attachments unavailable'); },
        rpcHandlerManager: {
            registerHandler: () => {}
        }
    }) as unknown as ApiSessionClient;
}
