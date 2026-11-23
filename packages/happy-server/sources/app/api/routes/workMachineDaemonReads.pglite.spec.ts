import { withSessionPiiModeMigration } from '@/testing/pgliteSessionModeFixture';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

/**
 * Reads Studio makes for a daemon, forwarding the daemon's own bearer
 * (specs/work-machine-migration plan 5.7, aplus-dev-studio). On a protected
 * machine that bearer is the `wmx_` device credential: it must answer for its
 * own machine while it is the current device and generation, and never for
 * another machine, an old generation or a frozen one. Real auth decorators.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/storage/db', () => ({
    get db() { return state.client; },
}));

const priorSecret = process.env.HANDY_MASTER_SECRET;
const priorAutomation = process.env.SAYCODE_AUTOMATION_ENABLED;
process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';
process.env.SAYCODE_AUTOMATION_ENABLED = 'true';

import { auth } from '@/app/auth/auth';
import { createSessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';
import { enableAuthentication, enableSessionScopeAuthentication } from '@/app/api/utils/enableAuthentication';
import { machineSessionOwnerRoutes } from './machineSessionOwnerRoutes';
import { automationRoutes } from './automationRoutes';

const ACCOUNT = 'account-1';
const MACHINE = 'work-machine';
const OTHER_MACHINE = 'other-machine';
const MINUTE = 60_000;

let sql: string;
let pg: PGlite;
let client: PrismaClient;
let app: Fastify;
let accountToken: string;

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
        { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
    sql = await withSessionPiiModeMigration(sql);
    await auth.init();
    accountToken = await auth.createToken(ACCOUNT);
    const issuer = await createSessionScopedTokenIssuer({ seed: 'test-scoped-seed-not-a-production-key' });

    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    enableAuthentication(typed);
    enableSessionScopeAuthentication(typed, () => issuer);
    machineSessionOwnerRoutes(typed);
    automationRoutes(typed);
    await typed.ready();
    app = typed;
});
afterAll(async () => {
    await app?.close();
    if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
    else process.env.HANDY_MASTER_SECRET = priorSecret;
    if (priorAutomation === undefined) delete process.env.SAYCODE_AUTOMATION_ENABLED;
    else process.env.SAYCODE_AUTOMATION_ENABLED = priorAutomation;
});

beforeEach(async () => {
    pg = new PGlite(); await pg.exec(sql);
    client = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    state.client = client;
    await client.account.create({ data: { id: ACCOUNT, publicKey: ACCOUNT } });
    for (const id of [MACHINE, OTHER_MACHINE]) {
        await client.machine.create({ data: { id, accountId: ACCOUNT, metadata: 'encrypted' } });
    }
    await client.workMachineExecution.create({
        data: { machineId: MACHINE, accountId: ACCOUNT, deviceId: 'new-device', generation: 2 },
    });
    await client.session.create({ data: { id: 'attached', tag: 'attached', accountId: ACCOUNT, metadata: 'm', workMachineId: MACHINE } });
    await client.session.create({ data: { id: 'unattached', tag: 'unattached', accountId: ACCOUNT, metadata: 'm' } });
});
afterEach(async () => { await client?.$disconnect(); await pg?.close(); });

function daemonCredential(over: { deviceId?: string; generation?: number; machineId?: string } = {}) {
    const now = Date.now();
    return auth.workMachineExecutionIssuer!.mint({
        accountId: ACCOUNT, machineId: over.machineId ?? MACHINE, deviceId: over.deviceId ?? 'new-device',
        generation: over.generation ?? 2, purpose: 'daemon', expiresAt: now + MINUTE,
    }, now);
}

function askOwner(bearer: string, sessionId: string, machineId = MACHINE) {
    return app.inject({
        method: 'POST', url: `/v1/machine-sessions/${sessionId}/owner`,
        headers: { authorization: `Bearer ${bearer}` }, payload: { machineId },
    });
}

describe('POST /v1/machine-sessions/:sessionId/owner with a work machine daemon credential', () => {
    it("answers for the current device's own conversation, also while draining", async () => {
        const bearer = await daemonCredential();
        const answer = await askOwner(bearer, 'attached');
        expect(answer.statusCode, answer.body).toBe(200);
        expect(answer.json()).toEqual({ owner: { ownerAccountId: ACCOUNT } });

        await client.workMachineExecution.update({ where: { machineId: MACHINE }, data: { drainingAt: new Date() } });
        expect((await askOwner(bearer, 'attached')).json()).toEqual({ owner: { ownerAccountId: ACCOUNT } });
    });

    it('does not vouch for a conversation of the account that is not attached to this work machine', async () => {
        const answer = await askOwner(await daemonCredential(), 'unattached');
        expect(answer.statusCode).toBe(200);
        expect(answer.json()).toEqual({ owner: null });
        // The account bearer keeps its same-account answer.
        expect((await askOwner(accountToken, 'unattached')).json()).toEqual({ owner: { ownerAccountId: ACCOUNT } });
    });

    it('refuses another machine, an old device or generation, and a frozen machine', async () => {
        const current = await daemonCredential();
        expect((await askOwner(current, 'attached', OTHER_MACHINE)).statusCode).toBe(403);
        expect((await askOwner(await daemonCredential({ machineId: OTHER_MACHINE }), 'attached', OTHER_MACHINE)).statusCode).toBe(403);
        expect((await askOwner(await daemonCredential({ deviceId: 'old-device', generation: 1 }), 'attached')).statusCode).toBe(403);
        expect((await askOwner(await daemonCredential({ generation: 1 }), 'attached')).statusCode).toBe(403);
        await client.workMachineExecution.update({ where: { machineId: MACHINE }, data: { frozenAt: new Date() } });
        expect((await askOwner(current, 'attached')).statusCode).toBe(403);
    });

    it('does not accept a session credential in place of the daemon credential', async () => {
        const now = Date.now();
        const session = await auth.workMachineExecutionIssuer!.mint({
            accountId: ACCOUNT, machineId: MACHINE, deviceId: 'new-device', generation: 2,
            purpose: 'session', sessionId: 'attached', expiresAt: now + MINUTE,
        }, now);
        expect((await askOwner(session, 'attached')).statusCode).toBe(401);
    });
});

describe('POST /v1/automation-runs/:runId/mcp-context with a work machine daemon credential', () => {
    const claimToken = 'claim-token';
    async function seedRunningRun() {
        const project = await client.project.create({ data: { accountId: ACCOUNT, name: 'protected-automation' } });
        const automation = await client.automation.create({ data: {
            projectId: project.id, ownerAccountId: ACCOUNT, machineAccountId: ACCOUNT, machineId: MACHINE,
            payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer', viewerKeyVersion: 1,
            viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
        } });
        const now = Date.now();
        const run = await client.automationRun.create({ data: {
            automationId: automation.id, generation: 1, scheduledFor: new Date(now), machineAccountId: ACCOUNT, machineId: MACHINE,
            status: 'RUNNING', claimTokenHash: new Uint8Array(createHash('sha256').update(claimToken).digest()),
            claimExpiresAt: new Date(now + MINUTE), claimedAt: new Date(now), startedAt: new Date(now),
            runLeaseExpiresAt: new Date(now + MINUTE),
        } });
        return { projectId: project.id, automationId: automation.id, runId: run.id };
    }
    function askContext(bearer: string, runId: string, machineId = MACHINE) {
        return app.inject({
            method: 'POST', url: `/v1/automation-runs/${runId}/mcp-context`,
            headers: { authorization: `Bearer ${bearer}` }, payload: { machineId, claimToken },
        });
    }

    it("answers the current device's claimed run, also while draining", async () => {
        const { projectId, automationId, runId } = await seedRunningRun();
        const bearer = await daemonCredential();
        const answer = await askContext(bearer, runId);
        expect(answer.statusCode, answer.body).toBe(200);
        expect(answer.json()).toMatchObject({ automationId, projectId, ownerAccountId: ACCOUNT, machineId: MACHINE });

        await client.workMachineExecution.update({ where: { machineId: MACHINE }, data: { drainingAt: new Date() } });
        expect((await askContext(bearer, runId)).statusCode).toBe(200);
    });

    it('refuses another machine, an old generation and a frozen machine', async () => {
        const { runId } = await seedRunningRun();
        const current = await daemonCredential();
        expect((await askContext(current, runId, OTHER_MACHINE)).statusCode).toBe(403);
        expect((await askContext(await daemonCredential({ deviceId: 'old-device', generation: 1 }), runId)).statusCode).toBe(403);
        await client.workMachineExecution.update({ where: { machineId: MACHINE }, data: { frozenAt: new Date() } });
        expect((await askContext(current, runId)).statusCode).toBe(403);
    });
});
