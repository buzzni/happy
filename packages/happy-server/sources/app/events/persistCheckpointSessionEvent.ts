import { db } from '@/storage/db';
import { Prisma } from '@prisma/client';
import type { CheckpointEventEnvelope } from './checkpointEventEnvelope';
import type { SessionEventType } from './sessionEventTypes';

export async function persistCheckpointSessionEvent(params: {
    sessionId: string;
    eventType: SessionEventType;
    content: string;
    checkpoint: CheckpointEventEnvelope;
}) {
    const { sessionId, eventType, content, checkpoint } = params;
    const idempotencyKey = `${eventType}:${checkpoint.operationId}:${checkpoint.state}`;
    try {
        const event = await db.$transaction(async (tx) => {
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
                    content: { t: 'encrypted', c: content },
                    checkpoint,
                    idempotencyKey,
                },
                select: { id: true, seq: true, createdAt: true },
            });
        });

        return { ...event, idempotent: false };
    } catch (error) {
        if (!isCheckpointIdempotencyConflict(error)) {
            throw error;
        }
        const existing = await db.sessionEvent.findFirst({
            where: { sessionId, idempotencyKey },
            select: { id: true, seq: true, createdAt: true },
        });
        if (!existing) throw error;
        return { ...existing, idempotent: true };
    }
}

function isCheckpointIdempotencyConflict(
    error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        return false;
    }
    const target = error.meta?.target;
    return Array.isArray(target)
        && target.length === 2
        && target.includes('sessionId')
        && target.includes('idempotencyKey');
}
