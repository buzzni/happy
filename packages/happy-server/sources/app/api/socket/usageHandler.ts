import { Socket } from "socket.io";
import { AsyncLock } from "@/utils/lock";
import { db } from "@/storage/db";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { persistSessionEvent } from "@/app/events/persistSessionEvent";
import { SESSION_EVENT_TYPES } from "@/app/events/sessionEventTypes";
import { log } from "@/utils/log";
import { AiUsageEventV1Schema, ProviderUsageEventV1Schema } from "@slopus/happy-wire";

export function usageHandler(userId: string, socket: Socket) {
    const receiveUsageLock = new AsyncLock();
    socket.on('provider-usage-report', async (data: unknown, callback?: (response: unknown) => void) => {
        await receiveUsageLock.inLock(async () => {
            const parsed = ProviderUsageEventV1Schema.safeParse(data);
            if (!parsed.success) {
                log({ module: 'websocket', level: 'warn' }, 'Rejected invalid provider usage event');
                callback?.({ success: false, error: 'Invalid provider usage event' });
                return;
            }

            try {
                const session = await db.session.findFirst({
                    where: { id: parsed.data.sessionId, accountId: userId },
                    select: { id: true },
                });
                if (!session) {
                    callback?.({ success: false, error: 'Session not found' });
                    return;
                }

                const event = AiUsageEventV1Schema.parse({
                    ...parsed.data,
                    happyAccountId: userId,
                });
                const usageEvent = await db.$transaction(async (tx) => {
                    const stored = await tx.providerUsageEvent.upsert({
                        where: {
                            source_sourceEventId: {
                                source: event.source,
                                sourceEventId: event.sourceEventId,
                            },
                        },
                        update: {},
                        create: {
                            accountId: userId,
                            sessionId: event.sessionId,
                            source: event.source,
                            sourceEventId: event.sourceEventId,
                            occurredAt: new Date(event.occurredAt),
                            data: event,
                        },
                    });
                    await tx.usageDeliveryOutbox.upsert({
                        where: { usageEventId: stored.id },
                        update: {},
                        create: { usageEventId: stored.id, nextAttemptAt: new Date() },
                    });
                    return stored;
                });
                callback?.({ success: true, eventId: usageEvent.id });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Failed to persist provider usage event: ${error}`);
                callback?.({ success: false, error: 'Failed to persist provider usage event' });
            }
        });
    });

    socket.on('usage-report', async (data: any, callback?: (response: any) => void) => {
        await receiveUsageLock.inLock(async () => {
            try {
                const { key, sessionId, tokens, cost } = data;

                // Validate required fields
                if (!key || typeof key !== 'string') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid key' });
                    }
                    return;
                }

                // Validate tokens and cost objects
                if (!tokens || typeof tokens !== 'object' || typeof tokens.total !== 'number') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid tokens object - must include total' });
                    }
                    return;
                }

                if (!cost || typeof cost !== 'object' || typeof cost.total !== 'number') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid cost object - must include total' });
                    }
                    return;
                }

                // Validate sessionId if provided
                if (sessionId && typeof sessionId !== 'string') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid sessionId' });
                    }
                    return;
                }

                try {
                    // If sessionId provided, verify it belongs to the user
                    if (sessionId) {
                        const session = await db.session.findFirst({
                            where: {
                                id: sessionId,
                                accountId: userId
                            }
                        });

                        if (!session) {
                            if (callback) {
                                callback({ success: false, error: 'Session not found' });
                            }
                            return;
                        }
                    }

                    // Prepare usage data
                    const usageData: PrismaJson.UsageReportData = {
                        tokens,
                        cost
                    };

                    // Upsert the usage report
                    const report = await db.usageReport.upsert({
                        where: {
                            accountId_sessionId_key: {
                                accountId: userId,
                                sessionId: sessionId || null,
                                key
                            }
                        },
                        update: {
                            data: usageData,
                            updatedAt: new Date()
                        },
                        create: {
                            accountId: userId,
                            sessionId: sessionId || null,
                            key,
                            data: usageData
                        }
                    });

                    log({ module: 'websocket' }, `Usage report saved: key=${key}, sessionId=${sessionId || 'none'}, userId=${userId}`);

                    // Emit usage ephemeral update if sessionId is provided
                    if (sessionId) {
                        const usageEvent = buildUsageEphemeral(sessionId, key, usageData.tokens, usageData.cost);
                        eventRouter.emitEphemeral({
                            userId,
                            payload: usageEvent,
                            recipientFilter: { type: 'user-scoped-only' }
                        });

                        // Persist usage-report event to durable log
                        persistSessionEvent({
                            sessionId,
                            eventType: SESSION_EVENT_TYPES.USAGE_REPORT,
                            content: '',
                        }).catch(error => {
                            log({ module: 'websocket', level: 'error' }, `Failed to persist usage-report event: ${error}`);
                        });
                    }

                    if (callback) {
                        callback({
                            success: true,
                            reportId: report.id,
                            createdAt: report.createdAt.getTime(),
                            updatedAt: report.updatedAt.getTime()
                        });
                    }
                } catch (error) {
                    log({ module: 'websocket', level: 'error' }, `Failed to save usage report: ${error}`);
                    if (callback) {
                        callback({ success: false, error: 'Failed to save usage report' });
                    }
                }
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in usage-report handler: ${error}`);
                if (callback) {
                    callback({ success: false, error: 'Internal error' });
                }
            }
        });
    });
}
