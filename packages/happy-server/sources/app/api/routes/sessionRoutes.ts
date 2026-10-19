import { Readable } from "node:stream";
import { parseCanonicalOrgSetupTokenJson } from "@slopus/happy-wire";
import { eventRouter, buildNewSessionUpdate } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";
import { sessionArchive } from "@/app/session/sessionArchive";
import { requireSessionScopeAuth, requireAccountPrincipal } from "@/app/api/utils/enableAuthentication";
import { createExecutionBoundSession, ExecutionBindingError } from "@/app/session/sessionExecutionBinding";

export function sessionRoutes(app: Fastify) {

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const sessions = await db.session.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                // messages: {
                //     orderBy: { seq: 'desc' },
                //     take: 1,
                //     select: {
                //         id: true,
                //         seq: true,
                //         content: true,
                //         localId: true,
                //         createdAt: true
                //     }
                // }
            }
        });

        return reply.send({
            sessions: sessions.map((v) => {
                // const lastMessage = v.messages[0];
                const sessionUpdatedAt = v.updatedAt.getTime();
                // const lastMessageCreatedAt = lastMessage ? lastMessage.createdAt.getTime() : 0;

                return {
                    id: v.id,
                    seq: v.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: sessionUpdatedAt,
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                    lastMessage: null
                };
            })
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            }))
        });
    });

    // A managed child may look up exactly its own session; the allowlist
    // checks the body, because this route takes its scope from there.
    app.post('/v2/sessions/lookup', {
        preHandler: requireSessionScopeAuth(app) as never,
        schema: {
            body: z.object({
                ids: z.array(z.string().min(1)).min(1).max(200),
                projection: z.enum(['seq', 'version']).optional(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const uniqueIds = Array.from(new Set(request.body.ids));
        const order = new Map(uniqueIds.map((id, index) => [id, index]));
        if (request.body.projection === 'seq') {
            const sessions = await db.session.findMany({
                where: { accountId: userId, id: { in: uniqueIds } },
                select: { id: true, seq: true },
            });
            return reply.send({
                sessions: sessions
                    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
                    .map(({ id, seq }) => ({ id, seq })),
            });
        }
        /*
         * A viewer reads with its own key envelope.
         *
         * The stored envelope is sealed for the account that owns the session.
         * A member of a company project reading it is a **different account**,
         * so the owner's envelope is bytes they cannot open — which shows up as
         * an empty conversation rather than as a permissions problem. A read
         * grant carries an envelope resealed for that viewer, and it is served
         * instead.
         *
         * When there is none, none is sent: `null` means "you cannot decrypt
         * this", which the client shows as locked. Substituting the owner's
         * would turn an honest refusal into a silent blank.
         */
        const grant = request.managedGrant;
        /*
         * Only a viewer who is somebody else needs a resealed envelope. When
         * the reader **is** the owner, the session's own envelope is already
         * sealed for them, and swapping in a `null` would lock an owner out of
         * their own transcript.
         */
        const grantViewer = grant?.purpose === 'transcript-read'
            && grant.viewerAccountId
            && grant.viewerAccountId !== grant.accountId
            ? grant
            : null;
        const viewerEnvelope = grantViewer
            ? { sessionId: grantViewer.sessionId, key: grantViewer.viewerDataEncryptionKey ?? null }
            : null;
        const servedDataEncryptionKey = (v: { id: string; dataEncryptionKey: Uint8Array | null }) => (
            viewerEnvelope && viewerEnvelope.sessionId === v.id
                ? (viewerEnvelope.key
                    ? Buffer.from(viewerEnvelope.key).toString('base64')
                    : null)
                : (v.dataEncryptionKey
                    ? Buffer.from(v.dataEncryptionKey).toString('base64')
                    : null)
        );
        /*
         * The runtime poll asks for this on every tick and fetches the full row
         * only when a version or key presence moved: encrypted bodies change
         * through the version-CAS socket handlers (versions bump) or a rewrap,
         * which re-encrypts them without a bump but only while filling a
         * missing envelope — key presence changes with it.
         */
        if (request.body.projection === 'version') {
            const rows = await db.session.findMany({
                where: { accountId: userId, id: { in: uniqueIds } },
                select: {
                    id: true,
                    seq: true,
                    createdAt: true,
                    updatedAt: true,
                    metadataVersion: true,
                    agentStateVersion: true,
                    dataEncryptionKey: true,
                    active: true,
                    lastActiveAt: true,
                },
            });
            return reply.send({
                sessions: rows
                    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
                    .map((v) => ({
                        id: v.id,
                        seq: v.seq,
                        createdAt: v.createdAt.getTime(),
                        updatedAt: v.updatedAt.getTime(),
                        active: v.active,
                        activeAt: v.lastActiveAt.getTime(),
                        metadataVersion: v.metadataVersion,
                        agentStateVersion: v.agentStateVersion,
                        hasDataEncryptionKey: servedDataEncryptionKey(v) !== null,
                    })),
            });
        }
        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                id: { in: uniqueIds }
            },
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });
        return reply.send({
            sessions: sessions
                .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
                .map((v) => ({
                    id: v.id,
                    seq: v.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: v.updatedAt.getTime(),
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    dataEncryptionKey: servedDataEncryptionKey(v),
                }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { accountId: userId };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            })),
            nextCursor,
            hasNext
        });
    });

    /*
     * Account sessions by recent activity, for clients that scan a time window
     * (specs/session-recent-list).
     *
     * `GET /v2/sessions` pages by id, i.e. by creation, so a scan cut off at a
     * row limit drops a long-lived session that was active yesterday. This one
     * pages by `(updatedAt, id)` descending with a keyset cursor. It is a new
     * path rather than a parameter on the old one: an older server would drop
     * an unknown parameter and answer in id order without the client noticing.
     * An older server answers this path with 404, or — self-hosted with the web
     * UI — with the SPA fallback's `index.html` and 200, which does not cover
     * `/v2`. Clients tell the two apart by content type, not status alone.
     *
     * The server never reads metadata here — which machine or project a session
     * belongs to is encrypted, so scoping is the caller's job after decryption.
     * `agentState` is left out to keep wide scans small.
     *
     * `updatedAt` is stored with millisecond precision, so the cursor's epoch
     * ms is the row's exact value and ties on it are split by id.
     */
    app.get('/v2/sessions/recent', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(100),
                since: z.coerce.number().int().positive().max(MAX_EPOCH_MS).optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 100, since } = request.query || {};

        let after: { updatedAt: Date; id: string } | null = null;
        if (cursor !== undefined) {
            after = parseRecentSessionsCursor(cursor);
            if (!after) {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        const where: Prisma.SessionWhereInput = { accountId: userId };
        const and: Prisma.SessionWhereInput[] = [];
        if (since !== undefined) {
            and.push({ updatedAt: { gte: new Date(since) } });
        }
        if (after) {
            // Implied by the OR below; stated separately because Postgres
            // does not derive an index bound from an OR, and without it every
            // page re-reads all newer rows of the account.
            and.push({ updatedAt: { lte: after.updatedAt } });
            and.push({
                OR: [
                    { updatedAt: { lt: after.updatedAt } },
                    { updatedAt: after.updatedAt, id: { lt: after.id } },
                ]
            });
        }
        if (and.length > 0) {
            where.AND = and;
        }

        const sessions = await db.session.findMany({
            where,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;
        const last = resultSessions[resultSessions.length - 1];
        const nextCursor = hasNext && last
            ? `cursor_v2_${last.updatedAt.getTime()}_${last.id}`
            : null;

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            })),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        // Inspect signed requests before Fastify's JSON parser collapses repeated
        // keys. Legacy payloads retain the existing parser and body-size limit.
        preParsing: async (request, _reply, payload) => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of payload) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.length;
                if (size > (request.server.initialConfig.bodyLimit ?? 1048576)) {
                    throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
                }
                chunks.push(bytes);
            }
            const raw = Buffer.concat(chunks);
            try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'executionProof')) {
                    parseCanonicalOrgSetupTokenJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
                }
            } catch { throw new ExecutionBindingError(400, 'Invalid session execution JSON'); }
            return Object.assign(Readable.from([raw]), { receivedEncodedLength: size });
        },
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                executionProof: z.unknown().optional(),
            }).passthrough()
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, dataEncryptionKey } = request.body;

        if (Object.prototype.hasOwnProperty.call(request.body, 'executionProof')) {
            if (request.principal?.kind !== 'account') return requireAccountPrincipal(request, reply);
            const { executionProof, ...createBody } = request.body;
            try {
                const session = await createExecutionBoundSession(userId, createBody, executionProof);
                return reply.send({ session: {
                    id: session.id, seq: session.seq, metadata: session.metadata, metadataVersion: session.metadataVersion,
                    agentState: session.agentState, agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active, activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(), updatedAt: session.updatedAt.getTime(), lastMessage: null,
                } });
            } catch (error) {
                if (error instanceof ExecutionBindingError) return reply.code(error.statusCode).send({ error: error.message });
                throw error;
            }
        }

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            log({ module: 'session-create', sessionId: session.id, userId, tag }, `Found existing session: ${session.id} for tag ${tag}`);
            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        } else {

            // Resolve seq
            const updSeq = await allocateUserSeq(userId);

            // Create session
            log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
            const session = await db.session.create({
                data: {
                    accountId: userId,
                    tag: tag,
                    metadata: metadata,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined
                }
            });
            log({ module: 'session-create', sessionId: session.id, userId }, `Session created: ${session.id}`);

            // Emit new session update
            const updatePayload = buildNewSessionUpdate(session, updSeq, randomKeyNaked(12));
            log({
                module: 'session-create',
                userId,
                sessionId: session.id,
                updateType: 'new-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting new-session update to user-scoped connections`);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        }
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });

    // Archive session (mark as inactive, idempotent)
    app.post('/v1/sessions/:sessionId/archive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const archived = await sessionArchive({ uid: userId }, sessionId);

        if (!archived) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}

/**
 * Last millisecond of year 9999. A JS `Date` reaches further, but Prisma
 * refuses to send a five-digit year, which would surface as a 500.
 */
const MAX_EPOCH_MS = 253_402_300_799_999;

/**
 * Reads `cursor_v2_<updatedAtMs>_<id>` back into the keyset position.
 *
 * Returns null for anything else, including a time past `MAX_EPOCH_MS` or
 * an id with NUL (PostgreSQL text cannot hold it), so a malformed cursor is a
 * 400 rather than a query error.
 */
function parseRecentSessionsCursor(cursor: string): { updatedAt: Date; id: string } | null {
    const match = /^cursor_v2_(\d{1,15})_([^\0]+)$/.exec(cursor);
    if (!match) return null;
    const updatedAtMs = Number(match[1]);
    if (updatedAtMs > MAX_EPOCH_MS) return null;
    return { updatedAt: new Date(updatedAtMs), id: match[2] };
}
