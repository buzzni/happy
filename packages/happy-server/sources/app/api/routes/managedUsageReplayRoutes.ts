import { z } from 'zod';
import { AiUsageEventV1Schema, ProviderUsageEventV1Schema } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import { resolveManagedDaemonGrant } from '@/app/managed/managedDaemonGrant';
import { deriveGrantFamily } from '@/app/managed/managedSessionGrant';
import { inTx } from '@/storage/inTx';

class ReplayDenied extends Error {}
/** Telemetry only. No session reads, grant issuance, provider execution or runner bearer. */
export function managedUsageReplayRoutes(app: Fastify, control: () => ManagedControlRuntime | null) {
    app.post('/v1/machines/:machineId/usage-replay', {
        bodyLimit: 64 * 1024,
        schema: { params: z.object({ machineId: z.string().min(1).max(200) }), body: ProviderUsageEventV1Schema },
    }, async (request, reply) => {
        const runtime = control();
        const token = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ''))?.[1];
        if (!runtime) return reply.code(503).send({ success: false });
        if (!token) return reply.code(401).send({ success: false });
        try {
            const verified = await runtime.daemonTokens.verify(token, Date.now());
            if (!verified.ok || verified.claims.machineId !== request.params.machineId) throw new ReplayDenied();
            const c = verified.claims;
            const event = AiUsageEventV1Schema.parse({ ...request.body, happyAccountId: c.accountId });
            const persist = () => inTx(async tx => {
                // Share locks fence cancellation/revoke/epoch/ownership changes through commit.
                // Values are parameters; the caller cannot choose tables or SQL.
                await tx.$queryRaw`SELECT "daemonGrantId" FROM "ManagedDaemonGrant" WHERE "daemonGrantId" = ${c.daemonGrantId} FOR SHARE`;
                await tx.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${c.machineId} FOR SHARE`;
                await tx.$queryRaw`SELECT "workspaceId" FROM "ManagedWorkspaceAuthority" WHERE "workspaceId" = ${c.workspaceId} FOR SHARE`;
                const candidates = await tx.$queryRaw<{ grantId: string }[]>`SELECT g."grantId" FROM "ManagedSessionGrant" g JOIN "ManagedRunAuthority" r ON r."runId" = g."runId"
                    JOIN "Session" s ON s."id" = g."sessionId" WHERE g."sessionId" = ${event.sessionId}
                    AND g."workspaceId" = ${c.workspaceId} AND g."purpose" = 'runner'
                    AND g."accountId" = ${c.accountId} AND s."accountId" = ${c.accountId}
                    AND r."accountId" = ${c.accountId} AND r."workspaceId" = ${c.workspaceId}
                    AND r."currentAttemptId" = g."attemptId" AND r."cancelledAt" IS NULL
                    AND g."revokedAt" IS NULL AND g."tombstone" = false AND g."epoch" = ${c.epoch}
                    AND g."runAuthorityVersion" = r."version"
                    AND g."workspaceAuthorityVersion" = (SELECT "version" FROM "ManagedWorkspaceAuthority" WHERE "workspaceId" = ${c.workspaceId})
                    LIMIT 2 FOR SHARE OF g, r, s`;
                const now = Date.now();
                const daemon = await resolveManagedDaemonGrant({ daemonGrantId: c.daemonGrantId, generation: c.generation, claims: c, now, tx });
                if (!daemon.ok || daemon.grant.generation !== c.generation || c.expiresAt <= now) throw new ReplayDenied();
                const workspace = await tx.managedWorkspaceAuthority.findUnique({ where: { workspaceId: c.workspaceId } });
                const grants = await tx.managedSessionGrant.findMany({ where: { grantId: { in: candidates.map(row => row.grantId) } }, take: 2 });
                if (!workspace || grants.length !== 1) throw new ReplayDenied();
                const g = grants[0];
                const run = g.runId ? await tx.managedRunAuthority.findUnique({ where: { runId: g.runId } }) : null;
                const session = await tx.session.findUnique({ where: { id: event.sessionId }, select: { id: true, accountId: true } });
                if (!run || !session || g.sessionId !== event.sessionId || g.workspaceId !== c.workspaceId || g.purpose !== 'runner'
                    || g.accountId !== c.accountId || session.accountId !== c.accountId || run.accountId !== c.accountId
                    || run.workspaceId !== c.workspaceId || run.cancelledAt !== null || g.revokedAt !== null || g.tombstone
                    || !g.attemptId || run.currentAttemptId !== g.attemptId || g.epoch !== c.epoch
                    || workspace.epoch !== c.epoch || workspace.runtimeId !== c.runtimeId || workspace.projectId !== c.projectId
                    || workspace.version !== g.workspaceAuthorityVersion || run.version !== g.runAuthorityVersion) throw new ReplayDenied();
                const family = deriveGrantFamily({ tenantId: workspace.tenantId, projectId: workspace.projectId, runtimeId: workspace.runtimeId,
                    workspaceId: c.workspaceId, epoch: c.epoch, runId: run.runId, attemptId: g.attemptId, sessionId: event.sessionId,
                    accountId: c.accountId, workspaceAuthorityVersion: workspace.version, runAuthorityVersion: run.version });
                if (g.family !== family) throw new ReplayDenied();
                // Runner expiry is not authorization here: the CURRENT daemon grant is. Cancellation
                // and runner revocation remain terminal fences even for telemetry.
                const stored = await tx.providerUsageEvent.upsert({
                    where: { source_sourceEventId: { source: event.source, sourceEventId: event.sourceEventId } }, update: {},
                    create: { accountId: c.accountId, sessionId: event.sessionId, source: event.source, sourceEventId: event.sourceEventId,
                        occurredAt: new Date(event.occurredAt), data: event },
                });
                if (stored.accountId !== c.accountId || stored.sessionId !== event.sessionId) throw new ReplayDenied();
                await tx.usageDeliveryOutbox.upsert({ where: { usageEventId: stored.id }, update: {}, create: { usageEventId: stored.id, nextAttemptAt: new Date() } });
            });
            for (let attempt = 0; ; attempt++) {
                try { await persist(); break; }
                catch (error) {
                    // Prisma reports serialization failures from raw locking SELECTs as P2010,
                    // whereas inTx handles P2034. Retry the WHOLE authorization+write transaction.
                    const failure = error as { code?: string; meta?: { code?: string } };
                    if (attempt >= 2 || failure.code !== 'P2010' || !['40001', '40P01'].includes(failure.meta?.code ?? '')) throw error;
                }
            }
            return { success: true };
        } catch (error) {
            // Fixed response only; driver errors may carry credentials or event contents.
            return reply.code(error instanceof ReplayDenied ? 403 : 503).send({ success: false });
        }
    });
}
