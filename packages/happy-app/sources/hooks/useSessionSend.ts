/**
 * Sending a message into a session whose CLI process may be gone.
 *
 * The send path used to be fire-and-forget: a message for a session with no
 * attached process was accepted by the server and answered by nobody, with no
 * error and no hint that anything had gone wrong (2026-08-15 incident — the
 * user waited on a reply that could never come). This hook makes that state
 * visible and, where the daemon allows it, recoverable.
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

export function useSessionSend(session: Session) {
    const sessionId = session.id;
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const sessionStatus = useSessionStatus(session);
    const expResumeSession = useSetting('expResumeSession');
    const navigateToSession = useNavigateToSession();
    const isConnected = sessionStatus.isConnected;

    return React.useCallback(async (text: string, options?: SendMessageOptions) => {
        if (isConnected) {
            sync.sendMessage(sessionId, text, options);
            return;
        }

        const availability = getResumeAvailability(session, machine, isConnected);

        // Whether or not this build can revive the session, the user must learn
        // that nothing is listening. Staying silent is the bug being fixed.
        if (!expResumeSession) {
            Modal.alert(t('common.error'), t('session.sendFailedNoRunningAgent'));
            return;
        }
        if (!availability.canResume) {
            Modal.alert(t('common.error'), availability.message || t('session.sendFailedNoRunningAgent'));
            return;
        }

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
                return;

            case 'prompt-delivered':
                // The daemon already handed this text to the new session, so
                // re-sending it here would duplicate the user's message.
                Modal.alert(t('common.success'), t('session.sessionRecoveredInNewConversation'));
                navigateToSession(outcome.sessionId);
                return;

            case 'failed':
                Modal.alert(t('common.error'), failureMessage(outcome));
                return;
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
