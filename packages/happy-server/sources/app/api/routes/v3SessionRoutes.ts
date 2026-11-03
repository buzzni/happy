import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeqBatch, allocateUserSeqBatch } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { z } from "zod";
import { type Fastify } from "../types";
import { requireSessionScopeAuth } from "@/app/api/utils/enableAuthentication";

// Pagination contract:
//   - after_seq=N  → forward sync: messages with seq > N, ordered ASC.
//                    Used by the client to pull anything new since the highest
//                    seq it has already seen.
//   - before_seq=N → backward paging: messages with seq < N, ordered DESC.
//                    Used by the client to lazy-load older history when the
//                    user scrolls up, so opening a long session does not block
//                    on fetching the entire history first.
// The two are mutually exclusive. With neither, the route defaults to
// `after_seq=0` (forward from the start) for backward compatibility.
const getMessagesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).optional(),
    before_seq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
}).refine(
    (data) => !(data.after_seq !== undefined && data.before_seq !== undefined),
    { message: "after_seq and before_seq are mutually exclusive" }
);

const sendMessagesBodySchema = z.object({
    messages: z.array(z.object({
        content: z.string(),
        localId: z.string().min(1)
    })).min(1).max(100)
});

type SelectedMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function toResponseMessage(message: SelectedMessage) {
    return {
        id: message.id,
        seq: message.seq,
        content: message.content,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

function toSendResponseMessage(message: Omit<SelectedMessage, "content">) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

export function v3SessionRoutes(app: Fastify) {
    // Reachable by a managed child for its own session. The ownership query
    // below is unchanged and still applies; the decorator adds the grant.
    app.get('/v3/sessions/:sessionId/messages', {
        preHandler: requireSessionScopeAuth(app) as never,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: getMessagesQuerySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { after_seq, before_seq, limit } = request.query;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Backward direction is opt-in via `before_seq`; everything else (no
        // params, or explicit `after_seq`) keeps the legacy forward semantics.
        const isBackward = before_seq !== undefined;
        const where = isBackward
            ? { sessionId, seq: { lt: before_seq } }
            : { sessionId, seq: { gt: after_seq ?? 0 } };
        const orderBy = isBackward
            ? { seq: 'desc' as const }
            : { seq: 'asc' as const };

        const messages = await db.sessionMessage.findMany({
            where,
            orderBy,
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                content: true,
                localId: true,
                createdAt: true,
                updatedAt: true
            }
        });

        const hasMore = messages.length > limit;
        const page = hasMore ? messages.slice(0, limit) : messages;

        return reply.send({
            messages: page.map(toResponseMessage),
            hasMore
        });
    });

    app.post('/v3/sessions/:sessionId/messages', {
        preHandler: requireSessionScopeAuth(app) as never,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: sendMessagesBodySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { messages } = request.body;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const firstMessageByLocalId = new Map<string, { localId: string; content: string }>();
        for (const message of messages) {
            if (!firstMessageByLocalId.has(message.localId)) {
                firstMessageByLocalId.set(message.localId, message);
            }
        }

        const uniqueMessages = Array.from(firstMessageByLocalId.values());
        const contentByLocalId = new Map(uniqueMessages.map((message) => [message.localId, message.content]));

        const txResult = await db.$transaction(async (tx) => {
            const localIds = uniqueMessages.map((message) => message.localId);
            const existing = await tx.sessionMessage.findMany({
                where: {
                    sessionId,
                    localId: { in: localIds }
                },
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    createdAt: true,
                    updatedAt: true
                }
            });

            const existingByLocalId = new Map<string, Omit<SelectedMessage, 'content'>>();
            for (const message of existing) {
                if (message.localId) {
                    existingByLocalId.set(message.localId, message);
                }
            }

            const newMessages = uniqueMessages.filter((message) => !existingByLocalId.has(message.localId));
            const seqs = await allocateSessionSeqBatch(sessionId, newMessages.length, tx);

            // One INSERT for the whole batch: the seq allocation above holds the
            // Session row lock until commit, so a per-message round-trip loop
            // kept it (and the transaction) open long enough to expire (P2028).
            const createdMessages: Omit<SelectedMessage, 'content'>[] = newMessages.length === 0
                ? []
                : (await tx.sessionMessage.createManyAndReturn({
                    data: newMessages.map((message, i) => ({
                        sessionId,
                        seq: seqs[i],
                        content: {
                            t: 'encrypted',
                            c: message.content
                        },
                        localId: message.localId
                    })),
                    select: {
                        id: true,
                        seq: true,
                        localId: true,
                        createdAt: true,
                        updatedAt: true
                    }
                })).sort((a, b) => a.seq - b.seq);

            const responseMessages = [...existing, ...createdMessages].sort((a, b) => a.seq - b.seq);

            return {
                responseMessages,
                createdMessages
            };
        }, {
            // Prisma's 5s default failed requests under DB slowness; match the
            // 10s `inTx` budget used by the server's other write transactions.
            timeout: 10000
        });

        // Announce outside the transaction, and take the whole block of update
        // seqs in one `Account.seq` increment: every writer for this account
        // contends on that single row, so N separate allocations would take
        // and release the same row lock N times for one request.
        const announcements = txResult.createdMessages.flatMap((message) => {
            const content = message.localId ? contentByLocalId.get(message.localId) : null;
            return content ? [{ message, content }] : [];
        });
        const updSeqs = await allocateUserSeqBatch(userId, announcements.length);

        for (let i = 0; i < announcements.length; i += 1) {
            const { message, content } = announcements[i];
            const updSeq = updSeqs[i];
            const updatePayload = buildNewMessageUpdate({
                ...message,
                content: {
                    t: 'encrypted',
                    c: content
                }
            }, sessionId, updSeq, randomKeyNaked(12));

            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });
        }

        return reply.send({
            messages: txResult.responseMessages.map(toSendResponseMessage)
        });
    });
}
