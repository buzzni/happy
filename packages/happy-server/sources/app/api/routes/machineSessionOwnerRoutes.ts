import { piiSessionVisibility } from "@/app/session/piiSessionVisibility";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { requireAccountPrincipal, requireWorkMachineDaemonReadAuth } from "../utils/enableAuthentication";
import { ExecutionOwnerRequestSchema, ExecutionOwnerResponseSchema } from "@slopus/happy-wire";

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
    app.get('/v1/org-endpoint-subagent/capabilities', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: { response: { 200: z.object({ orgEndpointSubagentVersion: z.literal(1), executionProofVersion: z.literal(1), relayTimeoutMs: z.literal(630000) }).strict() } },
    }, async () => ({ orgEndpointSubagentVersion: 1 as const, executionProofVersion: 1 as const, relayTimeoutMs: 630000 as const }));

    // A protected machine's daemon asks with its device credential; it vouches only for
    // conversations attached to that work machine, not for every session of the account.
    app.post('/v1/machine-sessions/:sessionId/owner', {
        preHandler: requireWorkMachineDaemonReadAuth(app, request => (request.body as { machineId?: string }).machineId),
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
            db.session.findFirst({ where: {
                ...piiSessionVisibility(request), id: request.params.sessionId, accountId: request.userId,
                ...(request.workMachineDaemonGrant ? { workMachineId: request.body.machineId } : {}),
            } }),
            db.machine.findFirst({ where: { id: request.body.machineId, accountId: request.userId } }),
        ]);

        if (!session || !machine) {
            return reply.send({ owner: null });
        }
        return reply.send({ owner: { ownerAccountId: request.userId } });
    });

    // An account bearer, or the current device credential of the machine the body names
    // (a protected machine's daemon: drain still allows these reads, a frozen machine does not).
    const accountOrMachineDaemon = [
        requireWorkMachineDaemonReadAuth(app, request => (request.body as { machineId?: string }).machineId),
        async (request: FastifyRequest, reply: FastifyReply) => request.workMachineDaemonGrant ? undefined : requireAccountPrincipal(request, reply),
    ];
    // The machine row a caller may ask about. The account bearer only reaches a machine
    // without work-machine authority, as the legacy lock does: an old PC still holding
    // the account token must not vouch for the protected machine's sessions.
    const askedMachine = (request: FastifyRequest, machineId: string) => ({
        id: machineId, accountId: request.userId,
        ...(request.workMachineDaemonGrant ? {} : { workMachineExecution: { is: null } }),
    });

    // Execution relation only. This grants neither session ownership nor message access.
    app.post('/v1/machine-sessions/:sessionId/execution-owner', {
        preHandler: accountOrMachineDaemon,
        schema: {
            params: z.object({ sessionId: z.string().min(1).max(128) }).strict(),
            body: ExecutionOwnerRequestSchema,
            response: { 200: ExecutionOwnerResponseSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const { companyId, machineId, launchId, initialNonce } = request.body;
        const sessionId = request.params.sessionId;
        const binding = await db.sessionExecutionBinding.findFirst({ where: {
            sessionId, companyId, machineId, launchId, initialNonce,
            machineOwnerAccountId: request.userId,
            machine: { is: askedMachine(request, machineId) },
            session: { is: { id: sessionId, ...(request.workMachineDaemonGrant ? { workMachineId: machineId } : {}) } },
        } });
        if (!binding) return reply.send({ owner: null });
        return reply.send({ owner: {
            companyId, machineId, sessionId, launchId, initialNonce,
            machineOwnerAccountId: binding.machineOwnerAccountId,
            sessionOwnerAccountId: binding.sessionOwnerAccountId,
        } });
    });

    // Recovery of an initial rotation create whose answer was lost: the session the launch
    // made, if any, of the caller's own account on the caller's own machine. It never creates
    // one, so a protected machine's daemon can recover without its proof still being fresh.
    // The snapshot is what the daemon needs to attach to the session; the device credential
    // reads no other session row.
    app.post('/v1/machine-sessions/execution-lookup', {
        preHandler: accountOrMachineDaemon,
        schema: {
            body: ExecutionOwnerRequestSchema,
            response: { 200: z.object({ session: z.object({
                id: z.string(), seq: z.number(), metadata: z.string(), metadataVersion: z.number(),
                agentState: z.string().nullable(), agentStateVersion: z.number(), dataEncryptionKey: z.string().nullable(),
            }).nullable() }) },
        },
    }, async (request, reply) => {
        // The answer carries the session's wrapped data key.
        reply.header('Cache-Control', 'no-store');
        const { companyId, machineId, launchId, initialNonce } = request.body;
        const binding = await db.sessionExecutionBinding.findFirst({
            where: {
                companyId, machineId, launchId, initialNonce,
                machineOwnerAccountId: request.userId, sessionOwnerAccountId: request.userId,
                machine: { is: askedMachine(request, machineId) },
                session: { is: {
                    ...piiSessionVisibility(request), accountId: request.userId,
                    ...(request.workMachineDaemonGrant ? { workMachineId: machineId } : {}),
                } },
            },
            select: { session: true },
        });
        const session = binding?.session;
        if (!session) return reply.send({ session: null });
        return reply.send({ session: {
            id: session.id, seq: session.seq, metadata: session.metadata, metadataVersion: session.metadataVersion,
            agentState: session.agentState, agentStateVersion: session.agentStateVersion,
            dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
        } });
    });

}
