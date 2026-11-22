import type { Prisma } from "@prisma/client";
import { db } from "@/storage/db";
import { allocateSessionEventSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { SESSION_EVENT_TYPES, type SessionEventType } from "@/app/events/sessionEventTypes";

/** Runs first inside the insert transaction; throwing from it writes nothing. */
export type SessionEventWriteGuard = (tx: Prisma.TransactionClient) => Promise<void>;

async function insertSessionEvent(params: {
    sessionId: string;
    eventType: SessionEventType;
    content: PrismaJson.SessionEventContent;
    guard?: SessionEventWriteGuard;
}) {
    const { sessionId, eventType, content, guard } = params;

    return db.$transaction(async (tx) => {
        await guard?.(tx);
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

/**
 * 세션이 한가해졌다는(`push-event` kind=done) 사실만 남긴다. 대화 내용은 담지 않으므로
 * 세션 키로 봉인된 대화에서도 web-ui 완료 알림이 이 기록으로 완료를 판정한다.
 */
export async function persistTurnReadySessionEvent(sessionId: string, guard?: SessionEventWriteGuard) {
    return insertSessionEvent({
        sessionId,
        eventType: SESSION_EVENT_TYPES.TURN_READY,
        content: { t: 'plain' },
        guard,
    });
}

export async function persistSessionEvent(params: {
    sessionId: string;
    eventType: SessionEventType;
    content: string;
    guard?: SessionEventWriteGuard;
}) {
    const { sessionId, eventType, content, guard } = params;

    const event = await insertSessionEvent({
        sessionId,
        eventType,
        content: { t: 'encrypted', c: content },
        guard,
    });

    return event;
}
