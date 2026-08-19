import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";

/**
 * Answers "does this machine own this session?" for a session that has no automation run
 * behind it — the case `saycode agent spawn` creates.
 *
 * Background (specs/cli-agent-spawn-project-visibility-server in aplus-dev-studio): A+ files a
 * conversation under a project only when something calls its assign endpoint. A spawned session's
 * CLI cannot: it authenticates with a sync-only access.key, which does not open `/api/*`. The
 * daemon does hold a machine token, so A+ lets the daemon ask on the session's behalf — but only
 * after Happy confirms the machine really owns that session. The existing automation route proves
 * this with a RUNNING run claim; a plain spawn has none.
 *
 * The proof used here is the AccessKey row. It exists exactly when a machine can decrypt a
 * session's data, which is precisely "this machine legitimately holds this session", and it is
 * already the same lookup the `access-key-get` socket handler trusts. No new grant, lease, or
 * claim concept is introduced.
 *
 * Absence answers 200 with `owner: null` rather than 404 on purpose: a server that predates this
 * route also answers 404, and the caller must distinguish "not the owner" (deny, fail closed)
 * from "route unavailable" (retry). With both outcomes on 200, any non-200 is an outage.
 */
export function machineSessionOwnerRoutes(app: Fastify) {
    app.post('/v1/machine-sessions/:sessionId/owner', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string().min(1) }),
            body: z.object({ machineId: z.string().min(1) }),
            response: {
                200: z.object({
                    owner: z.object({ ownerAccountId: z.string() }).nullable()
                })
            }
        }
    }, async (request, reply) => {
        // Scoped to the authenticated account, so a caller can only ever learn about sessions
        // its own token already reaches.
        const accessKey = await db.accessKey.findUnique({
            where: {
                accountId_machineId_sessionId: {
                    accountId: request.userId,
                    machineId: request.body.machineId,
                    sessionId: request.params.sessionId
                }
            }
        });

        if (!accessKey) {
            return reply.send({ owner: null });
        }
        return reply.send({ owner: { ownerAccountId: accessKey.accountId } });
    });
}
