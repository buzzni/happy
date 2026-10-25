import { z } from 'zod';
import { Readable } from 'node:stream';
import { parseCanonicalOrgSetupTokenJson } from '@slopus/happy-wire';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { requireAccountPrincipal } from '@/app/api/utils/enableAuthentication';
import { confirmOwnership, lookupOwnership, inspectOwnershipMachine, ownershipEnabled, OwnershipError } from '@/app/session/sessionOwnershipBinding';

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
}
