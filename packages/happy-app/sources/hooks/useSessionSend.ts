/**
 * Sending a message into a session whose CLI process may be gone.
 *
 * The send path used to be fire-and-forget: a message for a session with no
 * attached process was accepted by the server and answered by nobody, with no
 * error and no hint that anything had gone wrong (2026-08-15 incident — the
 * user waited on a reply that could never come). When the session's machine is
 * reachable, this hook revives the session before sending and surfaces every
 * failed revival instead of letting the message vanish into a dead session.
 *
 * When a revival cannot even be attempted — experiment off, machine offline,
 * no resumable backend id — the message is sent normally, NOT blocked. An
 * offline presence also covers a live CLI that is merely disconnected (laptop
 * lid closed); queueing on the server is the long-standing working flow for
 * that, the session header already shows the disconnected state, and since the
 * daemon now preserves the resume cursor, a queued message to a truly dead
 * session is replayed by the next successful resume rather than swallowed.
 */

import * as React from 'react';
import { getResumeAvailability } from '@/hooks/useSessionQuickActions';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineRecoverSession, machineResumeSession } from '@/sync/ops';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { prepareSessionForSend } from '@/sync/sessionRecovery';
import { storage, useMachine, useSetting } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync, type SendMessageOptions } from '@/sync/sync';
import { t } from '@/text';
import { useSessionStatus } from '@/utils/sessionUtils';

/**
 * Returns an async send function. Its result tells the caller whether the
 * message was consumed (sent, or already delivered to a recovered session) —
 * on `false` the caller must keep the composer text, because the composer has
 * no restore API and this is the user's only copy.
 */
export function useSessionSend(session: Session) {
    const sessionId = session.id;
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const sessionStatus = useSessionStatus(session);
    const expResumeSession = useSetting('expResumeSession');
    const navigateToSession = useNavigateToSession();
    const isConnected = sessionStatus.isConnected;
    // The recovery ladder takes seconds and the composer stays populated while
    // it runs, so a second tap would start a concurrent ladder for the same
    // text. Ignore sends until the first one settles.
    const recoveryInFlightRef = React.useRef(false);

    return React.useCallback(async (text: string, options?: SendMessageOptions): Promise<boolean> => {
        // An attachments-only send (empty text, images experiment) must not
        // enter the ladder: recover can only carry text, so the daemon rejects
        // an empty initialPrompt and the user would see a bare RPC error.
        // Queueing keeps the file events replayable like any other message.
        const attemptRecovery = !isConnected
            && expResumeSession
            && text.trim().length > 0
            && getResumeAvailability(session, machine, isConnected).canResume;

        if (!attemptRecovery) {
            sync.sendMessage(sessionId, text, options);
            return true;
        }

        if (recoveryInFlightRef.current) {
            return false;
        }
        recoveryInFlightRef.current = true;
        try {
            const modeMeta = resolveMessageModeMeta(session, storage.getState().settings);
            const outcome = await prepareSessionForSend({
                machineId,
                sessionId,
                text,
                model: modeMeta.model ?? undefined,
                permissionMode: modeMeta.permissionMode,
                resume: machineResumeSession,
                recover: (o) => machineRecoverSession({ ...o, machineId }),
            });

            switch (outcome.kind) {
                case 'send-normally':
                    sync.sendMessage(sessionId, text, options);
                    return true;

                case 'prompt-delivered':
                    // The daemon already handed this text to the new session, so
                    // re-sending it here would duplicate the user's message.
                    // Known limitation: recover carries text only — attachments
                    // queued alongside it are not forwarded to the new session.
                    Modal.alert(t('common.success'), t('session.sessionRecoveredInNewConversation'));
                    navigateToSession(outcome.sessionId);
                    return true;

                case 'failed':
                    // The daemon was reachable and confirmed it cannot revive
                    // this session right now — queueing would recreate the
                    // silent no-response this hook exists to fix.
                    Modal.alert(t('common.error'), failureMessage(outcome));
                    return false;
            }
        } finally {
            recoveryInFlightRef.current = false;
        }
    }, [sessionId, session, machine, isConnected, expResumeSession, machineId, navigateToSession]);
}

function failureMessage(outcome: { reason: 'directory-approval-required' | 'initial-prompt-not-delivered' } | { reason: 'rpc-error'; message: string }): string {
    switch (outcome.reason) {
        case 'directory-approval-required':
            return t('session.directoryApprovalRequired');
        case 'initial-prompt-not-delivered':
            return t('session.failedToDeliverInitialPrompt');
        case 'rpc-error':
            return outcome.message;
    }
}
