import { z } from 'zod';
import { Readable } from 'node:stream';
import { parseCanonicalOrgSetupTokenJson } from '@slopus/happy-wire';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { requireAccountPrincipal } from '@/app/api/utils/enableAuthentication';
import { confirmOwnership, lookupOwnership, inspectOwnershipMachine, ownershipEnabled, OwnershipError } from '@/app/session/sessionOwnershipBinding';
import { agentOwnershipRelationEnabled, createAgentOwnershipEligibility } from '@/app/session/agentOwnershipEligibility';
import { createRateLimiter } from '@/app/auth/selfHostAuthPolicy';

const relationRequest = z.object({
    v: z.literal(1), callerSessionId: z.string().min(1).max(128), machineId: z.string().min(1).max(128),
    sessionIds: z.array(z.string().min(1).max(128)).min(1).max(100),
}).strict();

export function sessionOwnershipRoutes(app: Fastify) {
    app.get('/v1/session-ownership/capabilities', async () => ({ sessionOwnershipV1: ownershipEnabled() }));
    // Assertions authenticate A+ itself. No shared Happy account may mint/confirm a personal owner.
    for (const path of ['confirm', 'lookup', 'machine'] as const) {
        const url = path === 'confirm' ? '/v1/session-ownership/:id/confirm' : '/v1/session-ownership/' + path;
        app.post(url, {
            preParsing: async (_request, _reply, payload) => {
                const chunks: Buffer[] = []; let size = 0;
                for await (const chunk of payload) {
                    const bytes = Buffer.from(chunk); size += bytes.length;
                    if (size > 65536) throw Object.assign(new Error('Body too large'), { statusCode: 413 });
                    chunks.push(bytes);
                }
                const raw = Buffer.concat(chunks);
                try { parseCanonicalOrgSetupTokenJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
                catch { throw new OwnershipError(400, 'Invalid ownership JSON'); }
                return Object.assign(Readable.from([raw]), { receivedEncodedLength: size });
            },
            schema: { body: z.unknown() },
        }, async (request, reply) => {
            try {
                if (path === 'confirm') {
                    const id = (request.params as { id: string }).id;
                    if ((request.body as { sessionId?: string })?.sessionId !== id) throw new OwnershipError(400, 'Session mismatch');
                    return reply.send({ ownership: await confirmOwnership(request.body) });
                }
                if (path === 'lookup') return reply.send({ sessions: await lookupOwnership(request.body) });
                return reply.send({ machine: await inspectOwnershipMachine(request.body) });
            } catch (error) {
                if (error instanceof OwnershipError) return reply.code(error.statusCode).send({ error: error.message });
                throw error;
            }
        });
    }
    // A machine's private runtime-home credential must agree with Happy's own row.
    app.post('/v1/session-ownership/machine-identity', {
        preHandler: app.authenticate, schema: { body: z.object({ machineId: z.string().min(1).max(128) }).strict() },
    }, async (request, reply) => {
        if (request.principal?.kind !== 'account') return requireAccountPrincipal(request, reply);
        if (!ownershipEnabled()) return reply.code(503).send({ error: 'Ownership unavailable' });
        const machine = await db.machine.findUnique({ where: { id: request.body.machineId } });
        return reply.send({ machine: machine?.accountId === request.userId
            ? { machineId: machine.id, accountId: machine.accountId } : null });
    });
    // The agent broker's personal same-account check (Desktop reason-network identity-adapter-plan H-S).
    // Only Happy's own row decides; list visibility is not ownership. Another account's session and a
    // missing one both read false, so the answer names no other account and is no existence oracle.
    app.post('/v1/session-ownership/same-account', {
        preHandler: app.authenticate, schema: { body: z.object({ sessionId: z.string().min(1).max(128) }).strict() },
    }, async (request, reply) => {
        if (request.principal?.kind !== 'account') return requireAccountPrincipal(request, reply);
        const session = await db.session.findFirst({ where: { id: request.body.sessionId, accountId: request.userId }, select: { id: true } });
        return reply.send({ sameAccount: session !== null });
    });
    // The agent broker's personal sibling relations, batched (Desktop reason-network
    // personal-ownership-simplification-plan §2). v1 `own` means only: personal Saycode
    // account + registered personal machine (A+, asked every time) + same Happy account.
    // Another account's session and a missing one both read not-own.
    const eligibility = createAgentOwnershipEligibility();
    const limiter = createRateLimiter({ relation: { limit: 120, windowMs: 60_000 } });
    app.post('/v1/session-ownership/relation', {
        preHandler: app.authenticate, schema: { body: relationRequest },
    }, async (request, reply) => {
        if (request.principal?.kind !== 'account') return requireAccountPrincipal(request, reply);
        const accountId = request.userId, body = request.body;
        const retryAfter = limiter('relation', accountId, Date.now());
        if (retryAfter) return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'Too many requests' });
        // Happy cannot bind a session to a machine, so each is checked against the caller on its own.
        const caller = await db.session.findFirst({ where: { id: body.callerSessionId, accountId }, select: { id: true } });
        const machine = await db.machine.findUnique({ where: { id: body.machineId } });
        if (!caller || machine?.accountId !== accountId) return reply.code(403).send({ error: 'Not the caller account' });
        const unavailable = { v: 1, callerAccountId: accountId, proof: null, unavailable: true };
        if (!agentOwnershipRelationEnabled()) return reply.send(unavailable);
        const verdict = await eligibility(accountId, body.machineId);
        if (verdict === 'unavailable') return reply.send(unavailable);
        const owned = verdict === 'eligible' ? new Set((await db.session.findMany({
            where: { id: { in: body.sessionIds }, accountId }, select: { id: true },
        })).map(session => session.id)) : new Set<string>();
        const relations = Object.fromEntries(body.sessionIds.map(id =>
            [id, owned.has(id) && id !== body.callerSessionId ? 'own' : 'not-own']));
        return reply.send({ v: 1, callerAccountId: accountId, proof: verdict === 'eligible' ? 'personal-same-account' : null, relations });
    });
}
