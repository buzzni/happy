import { db } from "@/storage/db";
import { allocateSessionEventSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import type { SessionEventType } from "@/app/events/sessionEventTypes";

async function insertSessionEvent(params: {
    sessionId: string;
    eventType: SessionEventType;
    content: PrismaJson.SessionEventContent;
}) {
    const { sessionId, eventType, content } = params;

    return db.$transaction(async (tx) => {
        const session = await tx.session.update({
            where: { id: sessionId },
            select: { eventSeq: true },
            data: { eventSeq: { increment: 1 } },
        });

        return tx.sessionEvent.create({
            data: {
                sessionId,
                eventType,
                seq: session.eventSeq,
                content,
            },
            select: {
                id: true,
                seq: true,
                createdAt: true,
            },
        });
    });
}

export async function persistSessionEvent(params: {
    sessionId: string;
    eventType: SessionEventType;
    content: string;
}) {
    const { sessionId, eventType, content } = params;

    const event = await insertSessionEvent({
        sessionId,
        eventType,
        content: { t: 'encrypted', c: content },
    });

    return event;
}
