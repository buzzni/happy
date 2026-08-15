/**
 * Pure session recovery decision logic.
 *
 * Decoupled from React/UI concerns and dependency-injected so it can be
 * unit-tested without mocking sockets or RPC.
 */

import type { SpawnSessionResult, RecoverSessionResult } from './ops';

export const RECOVERABLE_RESUME_CODES = [
    'SESSION_NOT_TRACKED',
    'SESSION_METADATA_MISSING',
    'SESSION_ENCRYPTION_MISSING',
    'SESSION_CURSOR_MISSING',
] as const;

/**
 * Check if a resume failure code is recoverable via recover-happy-session RPC.
 */
export function isRecoverableResumeFailure(code: string | undefined): boolean {
    if (!code) return false;
    return RECOVERABLE_RESUME_CODES.includes(code as any);
}

export type PrepareSendOutcome =
    | { kind: 'send-normally' }
    | { kind: 'prompt-delivered'; sessionId: string }
    /**
     * `reason` is what the caller renders. `message` carries the daemon's own
     * wording and is only present for 'rpc-error', where the daemon knows more
     * about the failure than the app can express.
     */
    | { kind: 'failed'; reason: 'directory-approval-required' | 'initial-prompt-not-delivered' }
    | { kind: 'failed'; reason: 'rpc-error'; message: string };

export async function prepareSessionForSend(input: {
    machineId: string;
    sessionId: string;
    text: string;
    model?: string;
    permissionMode?: string;
    resume: (o: {
        machineId: string;
        sessionId: string;
        model?: string;
        permissionMode?: string;
    }) => Promise<SpawnSessionResult>;
    recover: (o: {
        sessionId: string;
        initialPrompt: string;
        model?: string;
        permissionMode?: string;
    }) => Promise<RecoverSessionResult>;
}): Promise<PrepareSendOutcome> {
    const { machineId, sessionId, text, model, permissionMode, resume, recover } = input;

    // Try to resume the session.
    const resumeResult = await resume({
        machineId,
        sessionId,
        model,
        permissionMode,
    });

    if (resumeResult.type === 'success') {
        return { kind: 'send-normally' };
    }

    if (resumeResult.type === 'requestToApproveDirectoryCreation') {
        return { kind: 'failed', reason: 'directory-approval-required' };
    }

    // Resume failed. Check if the error is recoverable.
    const canRecover = isRecoverableResumeFailure(resumeResult.code);
    if (!canRecover) {
        return { kind: 'failed', reason: 'rpc-error', message: resumeResult.errorMessage };
    }

    // Attempt recovery.
    const recoverResult = await recover({
        sessionId,
        initialPrompt: text,
        model,
        permissionMode,
    });

    if (recoverResult.type === 'error') {
        return { kind: 'failed', reason: 'rpc-error', message: recoverResult.errorMessage };
    }

    // Recovery succeeded.
    if (recoverResult.recovery === 'same-session') {
        // The old session is alive again; send normally.
        return { kind: 'send-normally' };
    }

    // recovery === 'new-session'
    if (!recoverResult.initialPromptDelivered) {
        // Critical safety check: the new session didn't accept the initial
        // prompt. Treat as failure to prevent losing the user's message.
        return { kind: 'failed', reason: 'initial-prompt-not-delivered' };
    }

    // New session created and prompt delivered. Caller should navigate to it.
    return {
        kind: 'prompt-delivered',
        sessionId: recoverResult.sessionId,
    };
}
