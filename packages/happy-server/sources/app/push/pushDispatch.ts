/**
 * Push notification dispatch.
 *
 * Single entry point: dispatchSessionEventPush — rich session-event
 * ("It's ready!", permission, question) called by CLI/daemon clients.
 *
 * Generic per-message pushes were removed: the CLI streams every assistant
 * chunk, tool_use, and tool_result as a session message, so notifying on each
 * insert produced one buzz every 10s during a turn with no useful title.
 * Connected clients still receive the realtime message update over socket;
 * only the Expo push for "new message" went away.
 *
 * Suppression: if the user has a human-facing (user-scoped) client that is
 * active (connected + not backgrounded), suppress the push — they can see
 * in-app indicators (unread dots, tab title counter) instead. The CLI/agent's
 * own session-scoped socket for the very session that's dispatching this
 * push never counts as human presence — see hasActiveUserScopedSocketIn.
 *
 * "Active" is determined by socket.data.appState:
 *   - Clients send `app-state: { state: 'active' | 'background' }` via socket.
 *   - Old clients that never send it are treated as active (connected = present).
 *   - On disconnect the socket (and its state) disappears automatically.
 *
 * Every path returns a PushOutcome so the push-event route can report what
 * actually happened — before this, a total push outage looked identical to a
 * delivered push from the CLI, Desktop and logs alike.
 */

import { db } from "@/storage/db";
import { isUserActive } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { pushOutcomesCounter } from "@/app/monitoring/metrics2";
import { error, log } from "@/utils/log";

/**
 * What happened to one session-event push.
 * - suppressed: a UI client is active, nothing was sent
 * - no_tokens: the account has no registered device
 * - sent / partial / failed: every / some / no token got an ok ticket;
 *   failed also covers an exception anywhere in the dispatch
 */
export type PushOutcome = {
    status: 'sent' | 'partial' | 'suppressed' | 'no_tokens' | 'failed';
    tokens: number;
    sent: number;
    failed: number;
    reason?: string;
};

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}): Promise<PushOutcome> {
    // All push tokens are mobile — web/CLI never register Expo tokens.
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: params.userId }
    });

    if (tokens.length === 0) {
        log({ module: 'push' }, `No push tokens for user ${params.userId} session ${params.sessionId} — skipped`);
        return { status: 'no_tokens', tokens: 0, sent: 0, failed: 0 };
    }

    const tickets = await sendPushNotifications(
        tokens.map(t => ({
            to: t.token,
            title: params.title,
            body: params.body,
            data: params.data,
            sound: 'default' as const,
            channelId: params.channelId
        }))
    );

    let okCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
            okCount++;
            continue;
        }
        errors.push(ticket.details?.error || ticket.message || 'unknown');
        if (ticket.details?.error === 'DeviceNotRegistered') {
            void db.accountPushToken.deleteMany({
                where: { id: tokens[i].id }
            });
        }
    }

    // A token without a ticket was never confirmed delivered.
    const failedCount = tokens.length - okCount;
    if (failedCount === 0) {
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
        return { status: 'sent', tokens: tokens.length, sent: okCount, failed: 0 };
    }

    const reason = errors.length > 0 ? errors.join(', ') : 'missing ticket';
    const status = okCount === 0 ? 'failed' : 'partial';
    error({ module: 'push' }, `Push ${status} for user ${params.userId} session ${params.sessionId}: ok=${okCount} failed=${failedCount} errors=${JSON.stringify(errors)}`);
    return { status, tokens: tokens.length, sent: okCount, failed: failedCount, reason };
}

type SessionEventPush = {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
};

export async function dispatchSessionEventPush(params: SessionEventPush): Promise<PushOutcome> {
    const outcome = await dispatch(params);
    pushOutcomesCounter.inc({ status: outcome.status });
    return outcome;
}

async function dispatch(params: SessionEventPush): Promise<PushOutcome> {
    const { userId, sessionId, title, body, data } = params;

    try {
        try {
            if (await isUserActive(userId)) {
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active`);
                return { status: 'suppressed', tokens: 0, sent: 0, failed: 0, reason: 'user-active' };
            }
        } catch (presenceError) {
            error({ module: 'push' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        return await fetchTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages'
        });
    } catch (dispatchError) {
        error({ module: 'push' }, `Session-event push dispatch failed: ${dispatchError}`);
        const reason = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
        return { status: 'failed', tokens: 0, sent: 0, failed: 0, reason };
    }
}
