/**
 * The next turn of a live managed session, from a browser (T07-L5-b).
 *
 * The same shape as answering a permission prompt, for the same reasons: the
 * managed socket is the run's own connection, so a person's input arrives over
 * HTTP and is relayed on the connection that already exists. What differs is
 * the purpose — `message-send` — and the child's handler, `follow-up`.
 *
 * What is checked, and why each check is here:
 *
 *  - **The purpose.** Only `message-send` reaches this route (the allowlist
 *    refuses every other one). Deciding what the run may do (`approval-control`)
 *    is not authoring what it works on next, and a reader may do neither.
 *  - **The grant, freshly.** `authenticateSessionScope` re-reads it on every
 *    request; a sender whose access ended stops being relayed immediately, and
 *    the claims travel with the packet so the replica that owns the socket
 *    re-checks them just before the emit.
 *  - **The run.** The grant names the run it was minted for. A turn for an
 *    attempt that has since been superseded is a turn nobody is still running.
 *
 * The payload is sealed with the session key, which this server does not
 * hold. It is relayed exactly as received, and the child's sealed reply is
 * returned untouched: this route says `relayed`, never "accepted" — whether the
 * child took the turn is inside the sealed answer, and whether it *ran* is in
 * the run's own receipt.
 */
import { z } from 'zod';

import { dispatchManagedRpc, managedRpcServer } from '@/app/api/socket/managed/managedDelivery';
import type { Fastify } from '../types';
import { requireSessionScopeAuth } from '@/app/api/utils/enableAuthentication';

/** Base64 and nothing else — see `managedApprovalRoutes` for why the shape is refused here. */
const base64Payload = z.string().min(1).max(65_536).regex(/^[A-Za-z0-9+/]+={0,2}$/);

const followUpSchema = z.object({
    /** Correlates this call with its acknowledgement. The turn's own id is inside the sealed payload. */
    requestId: z.string().min(1).max(200),
    /**
     * The sealed `{ localId, text }` the child's `follow-up` handler reads.
     * Relayed **verbatim**: this server holds no key that opens it.
     */
    payload: base64Payload,
}).strict();

export function managedFollowUpRoutes(app: Fastify) {
    app.post('/v1/managed/sessions/:sessionId/follow-up', {
        preHandler: requireSessionScopeAuth(app) as never,
        schema: {
            params: z.object({ sessionId: z.string().min(1) }),
            body: followUpSchema,
        },
    }, async (request, reply) => {
        const principal = request.principal;
        if (!principal || principal.kind !== 'managed-session') {
            return reply.code(403).send({ error: 'Forbidden', reason: 'purpose-not-allowed' });
        }
        const grant = request.managedGrant;
        // The allowlist already refused every other purpose; stated again where
        // the handler can be read on its own.
        if (!grant || grant.purpose !== 'message-send') {
            return reply.code(403).send({ error: 'Forbidden', reason: 'purpose-not-allowed' });
        }
        const { sessionId } = request.params as { sessionId: string };
        if (grant.sessionId !== sessionId) {
            return reply.code(403).send({ error: 'Forbidden', reason: 'session-mismatch' });
        }

        const dispatched = await dispatchManagedRpc(managedRpcServer(), {
            sessionId,
            accountId: grant.accountId,
            rpcName: 'follow-up',
            requestId: request.body.requestId,
            params: request.body.payload,
            // Re-checked where the socket is, immediately before the emit — the
            // same rule as an approval: a sender withdrawn while the packet
            // waited must not have their turn started.
            approval: { claims: principal.claims },
        });
        if (!dispatched.ok) {
            // Never reported as taken: the person can try again.
            return reply.code(dispatched.reason === 'no-target' ? 409 : 503)
                .send({ error: 'Not relayed', reason: dispatched.reason });
        }
        if (typeof dispatched.result !== 'string') {
            return reply.code(502).send({ error: 'Not relayed', reason: 'malformed-response' });
        }
        return reply.send({ relayed: true, response: dispatched.result });
    });
}
