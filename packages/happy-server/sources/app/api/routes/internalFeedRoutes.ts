import { z } from 'zod';
import { Fastify } from '../types';
import { FeedBodySchema } from '@/app/feed/types';
import { feedPostToUser } from '@/app/feed/feedPostToUser';
import { inTx } from '@/storage/inTx';

/**
 * Internal collab-feed emit route.
 *
 * specs/collab-lifecycle-notifications Phase 1 (G1) — web-ui server calls
 * this endpoint (server-to-server, INSIDE the docker network) to push
 * collab-request lifecycle events to a target user. Authenticated via a
 * shared secret (`INTERNAL_FEED_TOKEN` env). Authentication failure returns
 * 401; body validation failure returns 400 (default fastify-zod path).
 *
 * Why a separate route instead of reusing the user-authenticated /v1/feed
 * surface: the actor (web-ui server) is not the target user. It needs to
 * post into another user's feed without holding that user's session token.
 * Cross-service write coupling against PG was the alternative (R2-b) but
 * was rejected (D2-1, 2026-05-17) — coupling happy-server schema directly
 * into web-ui is worse than an explicit HTTP boundary.
 *
 * Best-effort from the caller's side: web-ui's `collabFeedClient` swallows
 * non-2xx responses and warns (see specs/.../plan.md Phase 2.2) so an emit
 * outage never rolls back the underlying mutation.
 */

const HEADER_NAME = 'x-internal-token';

/**
 * Shared-secret check. Both empty and undefined env values close the gate
 * — `INTERNAL_FEED_TOKEN` unset in an environment that wires this route is
 * a configuration bug, and we'd rather fail closed than ship a wide-open
 * surface by accident.
 */
export function verifyInternalToken(
    headerValue: string | undefined,
    expected: string | undefined,
): boolean {
    if (!expected) return false;
    if (!headerValue) return false;
    return headerValue === expected;
}

export const InternalCollabFeedBodySchema = z.object({
    targetUserId: z.string().min(1),
    body: FeedBodySchema,
});

export function internalFeedRoutes(app: Fastify) {
    app.post('/v1/internal/collab-feed-post', {
        schema: {
            body: InternalCollabFeedBodySchema,
            response: {
                200: z.object({ ok: z.literal(true) }),
                401: z.object({ error: z.literal('unauthorized') }),
            },
        },
    }, async (request, reply) => {
        const headerRaw = request.headers[HEADER_NAME];
        const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
        if (!verifyInternalToken(headerValue, process.env.INTERNAL_FEED_TOKEN)) {
            return reply.code(401).send({ error: 'unauthorized' as const });
        }

        const { targetUserId, body } = request.body;

        await inTx(async (tx) => {
            await feedPostToUser(tx, targetUserId, body);
        });

        return reply.send({ ok: true as const });
    });
}
