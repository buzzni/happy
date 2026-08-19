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
 * The proof is a same-account check: `Session.accountId` and `Machine.accountId` are plain
 * columns, and `accessKeysRoutes.ts`'s own handlers already trust exactly this pair before
 * touching either row. This is NOT the same claim as "this specific machine spawned this specific
 * session" — any machine on the account can now vouch for any session on the account. A first cut
 * of this endpoint used the `AccessKey` table for a machine-specific proof instead, on the
 * assumption that some Happy client populates it (an existing GET handler already trusts it).
 * Production E2E testing found that table permanently empty — no Happy client, CLI or app, ever
 * calls the route that would write to it, so it carried no real signal. This is the proof that
 * is actually backed by data every session and machine already has.
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
        // Scoped to the authenticated account both ways, so a caller can only ever learn about
        // its own sessions and its own machines.
        const [session, machine] = await Promise.all([
            db.session.findFirst({ where: { id: request.params.sessionId, accountId: request.userId } }),
            db.machine.findFirst({ where: { id: request.body.machineId, accountId: request.userId } }),
        ]);

        if (!session || !machine) {
            return reply.send({ owner: null });
        }
        return reply.send({ owner: { ownerAccountId: request.userId } });
    });
}
