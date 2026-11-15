import { randomBytes, randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => {
    const url = process.env.HAPPY_USAGE_REPLAY_TEST_DATABASE_URL;
    if (url) {
        const target = new URL(url);
        if (target.hostname !== '127.0.0.1' || target.pathname !== '/usage_verify') throw new Error('synthetic local fixture database required');
        process.env.DATABASE_URL = url; process.env.DB_PROVIDER = 'postgres';
    }
});
import { db } from '@/storage/db';
import { managedUsageReplayRoutes } from './managedUsageReplayRoutes';
import { deriveGrantFamily, type ManagedScope } from '@/app/managed/managedSessionGrant';
import { createManagedDaemonTokenIssuer } from '@/app/auth/managedDaemonToken';

it.skipIf(!process.env.HAPPY_USAGE_REPLAY_TEST_DATABASE_URL)('real PostgreSQL transaction fences cancellation and handles historical grants, duplicate ACKs, revocation', async () => {
    const id = (suffix: string) => `${prefix}-${suffix}`;
    const prefix = `usage-replay-${randomUUID()}`;
    const now = Date.now();
    const scope: ManagedScope = { tenantId: id('tenant'), projectId: id('project'), workspaceId: id('workspace'), runtimeId: id('runtime'), epoch: 1,
        runId: id('run'), attemptId: id('attempt'), sessionId: id('session'), accountId: id('account'), workspaceAuthorityVersion: 1, runAuthorityVersion: 1 };
    const issuer = await createManagedDaemonTokenIssuer({ seed: randomBytes(32).toString('hex') });
    if (!issuer) throw new Error('fixture issuer unavailable');
    const minted = await issuer.mint({ v: 1, accountId: scope.accountId, machineId: id('machine'), runtimeId: scope.runtimeId,
        provisioningOperationId: id('provision'), daemonGrantId: id('daemon'), generation: 1, workspaceId: scope.workspaceId,
        projectId: scope.projectId, epoch: 1, expiresAt: now + 60000 }, now);
    if (!minted.ok) throw new Error('fixture token unavailable');
    const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    managedUsageReplayRoutes(app as never, () => ({ daemonTokens: issuer } as never));
    const event = { source: 'happy-cli', sourceEventId: id('event'), schemaVersion: 1, occurredAt: now, sessionId: scope.sessionId,
        provider: 'anthropic', agent: 'claude', model: 'synthetic', measurement: 'delta', quality: 'exact', cost: null,
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3 } };
    const request = async (suffix = 'event') => app.inject({ method: 'POST', url: `/v1/machines/${id('machine')}/usage-replay`,
        headers: { authorization: `Bearer ${minted.token}` }, payload: { ...event, sourceEventId: id(suffix) } });
    try {
        await db.account.create({ data: { id: scope.accountId, publicKey: id('public') } });
        await db.machine.create({ data: { id: id('machine'), accountId: scope.accountId, metadata: 'synthetic' } });
        await db.session.create({ data: { id: scope.sessionId, accountId: scope.accountId, tag: prefix, metadata: 'synthetic' } });
        await db.managedWorkspaceAuthority.create({ data: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, projectId: scope.projectId,
            epoch: 1, runtimeId: scope.runtimeId, version: 1, bodyDigest: prefix, createdAt: BigInt(now), updatedAt: BigInt(now) } });
        await db.managedRunAuthority.create({ data: { runId: scope.runId, workspaceId: scope.workspaceId, accountId: scope.accountId,
            currentAttemptId: scope.attemptId, version: 1, bodyDigest: prefix, createdAt: BigInt(now), updatedAt: BigInt(now) } });
        await db.managedDaemonGrant.create({ data: { daemonGrantId: id('daemon'), accountId: scope.accountId, machineId: id('machine'), runtimeId: scope.runtimeId,
            provisioningOperationId: id('provision'), workspaceId: scope.workspaceId, projectId: scope.projectId, epoch: 1, generation: 1,
            expiresAt: BigInt(now + 60000), requestId: id('daemon-request'), bodyDigest: prefix, createdAt: BigInt(now), updatedAt: BigInt(now) } });
        for (const attempt of ['old-revoked', 'old-stale', 'attempt']) {
            const scoped = { ...scope, attemptId: id(attempt) };
            await db.managedSessionGrant.create({ data: { grantId: id(`grant-${attempt}`), family: deriveGrantFamily(scoped), sessionId: scope.sessionId,
                workspaceId: scope.workspaceId, runId: scope.runId, attemptId: scoped.attemptId, accountId: scope.accountId, purpose: 'runner', epoch: 1,
                workspaceAuthorityVersion: 1, runAuthorityVersion: 1, expiresAt: BigInt(now - 1), revokedAt: attempt === 'old-revoked' ? BigInt(now) : null,
                requestId: id(`request-${attempt}`), bodyDigest: prefix, createdAt: BigInt(now), updatedAt: BigInt(now) } });
        }
        expect((await request()).statusCode).toBe(200); expect((await request()).json()).toEqual({ success: true });
        expect(await db.providerUsageEvent.count({ where: { accountId: scope.accountId } })).toBe(1);
        expect(await db.usageDeliveryOutbox.count({ where: { usageEvent: { accountId: scope.accountId } } })).toBe(1);
        await db.managedSessionGrant.update({ where: { grantId: id('grant-attempt') }, data: { revokedAt: BigInt(now) } });
        expect((await request('revoked')).statusCode).toBe(403);
        await db.managedSessionGrant.update({ where: { grantId: id('grant-attempt') }, data: { revokedAt: null } });
        let unlock!: () => void, locked!: () => void;
        const gate = new Promise<void>(resolve => { unlock = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
        const cancel = db.$transaction(async tx => {
            await tx.$queryRaw`SELECT "runId" FROM "ManagedRunAuthority" WHERE "runId"=${scope.runId} FOR UPDATE`;
            locked(); await gate;
            await tx.managedRunAuthority.update({ where: { runId: scope.runId }, data: { cancelledAt: BigInt(now) } });
        }, { timeout: 10000 });
        await acquired;
        const replay = request('cancel-race');
        try {
            let waiting = false;
            for (let i = 0; i < 100 && !waiting; i++) {
                const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ManagedSessionGrant%'`;
                waiting = rows[0].n > 0n;
                if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
        } finally { unlock(); await cancel; }
        expect((await replay).statusCode).toBe(403);
        await db.managedDaemonGrant.update({ where: { daemonGrantId: id('daemon') }, data: { revokedAt: BigInt(now) } });
        expect((await request('daemon-revoked')).statusCode).toBe(403);
        expect(await db.providerUsageEvent.count({ where: { accountId: scope.accountId } })).toBe(1);
    } finally {
        await app.close();
        await db.usageDeliveryOutbox.deleteMany({ where: { usageEvent: { accountId: scope.accountId } } });
        await db.providerUsageEvent.deleteMany({ where: { accountId: scope.accountId } });
        await db.managedSessionGrant.deleteMany({ where: { workspaceId: scope.workspaceId } });
        await db.managedRunAuthority.deleteMany({ where: { runId: scope.runId } });
        await db.managedDaemonGrant.deleteMany({ where: { daemonGrantId: id('daemon') } });
        await db.managedWorkspaceAuthority.deleteMany({ where: { workspaceId: scope.workspaceId } });
        await db.session.deleteMany({ where: { id: scope.sessionId } }); await db.machine.deleteMany({ where: { id: id('machine') } });
        await db.account.deleteMany({ where: { id: scope.accountId } }); await db.$disconnect();
    }
}, 30000);
