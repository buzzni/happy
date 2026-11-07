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
 * Budget for one dispatch, from the presence check to the last Expo batch.
 * The push-event route awaits it, so it stays inside the CLI's 15s timeout.
 */
const DISPATCH_BUDGET_MS = 10_000;

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
    deadline: number;
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
        })),
        { timeoutMs: Math.max(0, params.deadline - Date.now()) }
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
            // Prisma queries are lazy: without .then/.catch this never runs.
            db.accountPushToken.deleteMany({
                where: { id: tokens[i].id }
            }).catch(deleteError => {
                error({ module: 'push' }, `Failed to remove unregistered push token ${tokens[i].id}: ${deleteError}`);
            });
        }
    }

    // A token without a ticket was never confirmed delivered.
    const failedCount = tokens.length - okCount;
    if (failedCount === 0) {
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
        return { status: 'sent', tokens: tokens.length, sent: okCount, failed: 0 };
    }

    // Distinct causes only — one Expo outage would otherwise repeat per token.
    const reason = errors.length > 0 ? [...new Set(errors)].join(', ') : 'missing ticket';
    const status = okCount === 0 ? 'failed' : 'partial';
    error({ module: 'push' }, `Push ${status} for user ${params.userId} session ${params.sessionId}: ok=${okCount} failed=${failedCount} reason=${reason}`);
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
    countPushOutcome(outcome);
    return outcome;
}

/** Counts an outcome decided outside dispatch (e.g. a SILENT automation run). */
export function countPushOutcome(outcome: PushOutcome): void {
    pushOutcomesCounter.inc({ status: outcome.status });
}

async function dispatch(params: SessionEventPush): Promise<PushOutcome> {
    const { userId, sessionId, title, body, data } = params;
    const deadline = Date.now() + DISPATCH_BUDGET_MS;

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
            channelId: 'messages',
            deadline
        });
    } catch (dispatchError) {
        error({ module: 'push' }, `Session-event push dispatch failed: ${dispatchError}`);
        // The error class only: messages (e.g. Prisma's) can carry DB hosts and
        // query details, and this reason goes back in the HTTP response.
        const reason = `exception:${dispatchError instanceof Error ? dispatchError.name : 'unknown'}`;
        return { status: 'failed', tokens: 0, sent: 0, failed: 0, reason };
    }
}
