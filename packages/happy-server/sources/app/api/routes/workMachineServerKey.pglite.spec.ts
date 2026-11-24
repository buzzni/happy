import { withSessionPiiModeMigration } from '@/testing/pgliteSessionModeFixture';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

/**
 * specs/work-machine-migration (aplus-dev-studio) — after a replace or restore the
 * server copies of the machine key (serverDataEncryptionKey, serverRpcKeyEnvelope)
 * are cleared with the old key. The new current device uploads them again with its
 * own `wmx_` daemon credential: only for its machine and generation, only into an
 * empty slot, and only while the machine still has the data key it read.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/storage/db', () => ({
    get db() { return state.client; },
}));

const priorSecret = process.env.HANDY_MASTER_SECRET;
process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';

import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { machinesRoutes } from './machinesRoutes';

const ACCOUNT = 'account-1';
const MACHINE = 'work-machine';
const OTHER_MACHINE = 'other-machine';
const MINUTE = 60_000;

/** A version-0 envelope of the canonical length (105 bytes). */
const envelope = () => Buffer.concat([Buffer.from([0]), randomBytes(104)]);
const b64 = (bytes: Buffer) => bytes.toString('base64');

let sql: string;
let pg: PGlite;
let client: PrismaClient;
let app: Fastify;
let accountToken: string;
let dataKey: Buffer;

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
        { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
    sql = await withSessionPiiModeMigration(sql);
    await auth.init();
    accountToken = await auth.createToken(ACCOUNT);
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    enableAuthentication(typed);
    machinesRoutes(typed);
    await typed.ready();
    app = typed;
});
afterAll(async () => {
    await app?.close();
    if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
    else process.env.HANDY_MASTER_SECRET = priorSecret;
});

beforeEach(async () => {
    pg = new PGlite(); await pg.exec(sql);
    client = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    state.client = client;
    await client.account.create({ data: { id: ACCOUNT, publicKey: ACCOUNT } });
    dataKey = envelope();
    // As handoffWorkMachineExecution leaves it: the new data key, no server copies.
    await client.machine.create({ data: { id: MACHINE, accountId: ACCOUNT, metadata: 'encrypted', dataEncryptionKey: new Uint8Array(dataKey) } });
    await client.machine.create({ data: { id: OTHER_MACHINE, accountId: ACCOUNT, metadata: 'encrypted', dataEncryptionKey: new Uint8Array(envelope()) } });
    await client.workMachineExecution.create({
        data: { machineId: MACHINE, accountId: ACCOUNT, deviceId: 'new-device', generation: 2 },
    });
});
afterEach(async () => { await client?.$disconnect(); await pg?.close(); });

function daemonCredential(over: { deviceId?: string; generation?: number; machineId?: string } = {}) {
    const now = Date.now();
    return auth.workMachineExecutionIssuer!.mint({
        accountId: ACCOUNT, machineId: over.machineId ?? MACHINE, deviceId: over.deviceId ?? 'new-device',
        generation: over.generation ?? 2, purpose: 'daemon', expiresAt: now + MINUTE,
    }, now);
}

function upload(bearer: string, body: { expectedDataEncryptionKey?: Buffer; serverRpcKeyEnvelope: Buffer; serverDataEncryptionKey?: Buffer | null }, machineId = MACHINE) {
    return app.inject({
        method: 'PUT', url: `/v1/machines/${machineId}/server-key-envelopes`,
        headers: { authorization: `Bearer ${bearer}` },
        payload: {
            expectedDataEncryptionKey: b64(body.expectedDataEncryptionKey ?? dataKey),
            serverRpcKeyEnvelope: b64(body.serverRpcKeyEnvelope),
            serverDataEncryptionKey: body.serverDataEncryptionKey ? b64(body.serverDataEncryptionKey) : null,
        },
    });
}

async function stored(machineId = MACHINE) {
    const machine = await client.machine.findUniqueOrThrow({ where: { id: machineId } });
    const bytes = (value: Uint8Array | null) => value ? Buffer.from(value).toString('base64') : null;
    return {
        dataEncryptionKey: bytes(machine.dataEncryptionKey),
        serverRpcKeyEnvelope: bytes(machine.serverRpcKeyEnvelope),
        serverDataEncryptionKey: bytes(machine.serverDataEncryptionKey),
        dataKeyAttestation: bytes(machine.dataKeyAttestation),
    };
}

describe('PUT /v1/machines/:id/server-key-envelopes with the current device credential', () => {
    it('fills the missing server copies for the current data key, and a repeat converges', async () => {
        const lane = envelope();
        const escrow = envelope();
        const bearer = await daemonCredential();
        const first = await upload(bearer, { serverRpcKeyEnvelope: lane, serverDataEncryptionKey: escrow });
        expect(first.statusCode, first.body).toBe(200);
        expect(first.json()).toEqual({ ok: true, changed: true });
        expect(await stored()).toEqual({
            dataEncryptionKey: b64(dataKey), serverRpcKeyEnvelope: b64(lane), serverDataEncryptionKey: b64(escrow), dataKeyAttestation: null,
        });

        const again = await upload(bearer, { serverRpcKeyEnvelope: lane, serverDataEncryptionKey: escrow });
        expect(again.statusCode).toBe(200);
        expect(again.json()).toEqual({ ok: true, changed: false });
    });

    it('fills only the server-lane copy for a strict device, and is allowed while draining', async () => {
        await client.workMachineExecution.update({ where: { machineId: MACHINE }, data: { drainingAt: new Date() } });
        const lane = envelope();
        const answer = await upload(await daemonCredential(), { serverRpcKeyEnvelope: lane });
        expect(answer.statusCode, answer.body).toBe(200);
        expect(await stored()).toMatchObject({ serverRpcKeyEnvelope: b64(lane), serverDataEncryptionKey: null });
    });

    it('never overwrites a present copy with a different one', async () => {
        const lane = envelope();
        const escrow = envelope();
        await client.machine.update({ where: { id: MACHINE }, data: { serverRpcKeyEnvelope: new Uint8Array(lane), serverDataEncryptionKey: new Uint8Array(escrow) } });
        const bearer = await daemonCredential();
        const otherLane = await upload(bearer, { serverRpcKeyEnvelope: envelope(), serverDataEncryptionKey: escrow });
        expect(otherLane.statusCode).toBe(409);
        expect(otherLane.json()).toMatchObject({ error: 'server-key-conflict' });
        const otherEscrow = await upload(bearer, { serverRpcKeyEnvelope: lane, serverDataEncryptionKey: envelope() });
        expect(otherEscrow.statusCode).toBe(409);
        expect(await stored()).toMatchObject({ serverRpcKeyEnvelope: b64(lane), serverDataEncryptionKey: b64(escrow) });
    });

    it('fills neither slot when one of them already holds a different copy', async () => {
        const escrow = envelope();
        await client.machine.update({ where: { id: MACHINE }, data: { serverDataEncryptionKey: new Uint8Array(escrow) } });
        const answer = await upload(await daemonCredential(), { serverRpcKeyEnvelope: envelope(), serverDataEncryptionKey: envelope() });
        expect(answer.statusCode).toBe(409);
        expect(await stored()).toMatchObject({ serverRpcKeyEnvelope: null, serverDataEncryptionKey: b64(escrow) });
    });

    it('writes nothing when the machine no longer has the data key the device read', async () => {
        const answer = await upload(await daemonCredential(), { expectedDataEncryptionKey: envelope(), serverRpcKeyEnvelope: envelope(), serverDataEncryptionKey: envelope() });
        expect(answer.statusCode).toBe(409);
        expect(answer.json()).toMatchObject({ error: 'data-encryption-key-conflict' });
        expect(await stored()).toMatchObject({ dataEncryptionKey: b64(dataKey), serverRpcKeyEnvelope: null, serverDataEncryptionKey: null });
    });

    it('cannot change the data key itself', async () => {
        const body = await app.inject({
            method: 'PUT', url: `/v1/machines/${MACHINE}/server-key-envelopes`,
            headers: { authorization: `Bearer ${await daemonCredential()}` },
            payload: { expectedDataEncryptionKey: b64(dataKey), serverRpcKeyEnvelope: b64(envelope()), serverDataEncryptionKey: null, dataEncryptionKey: b64(envelope()) },
        });
        expect(body.statusCode).toBe(400);
        expect(await stored()).toMatchObject({ dataEncryptionKey: b64(dataKey), serverRpcKeyEnvelope: null });
    });

    it('refuses another machine, an old device or generation, and a frozen machine', async () => {
        const lane = envelope();
        const current = await daemonCredential();
        expect((await upload(current, { serverRpcKeyEnvelope: lane }, OTHER_MACHINE)).statusCode).toBe(403);
        expect((await upload(await daemonCredential({ machineId: OTHER_MACHINE }), { serverRpcKeyEnvelope: lane }, OTHER_MACHINE)).statusCode).toBe(403);
        expect((await upload(await daemonCredential({ deviceId: 'old-device', generation: 1 }), { serverRpcKeyEnvelope: lane })).statusCode).toBe(403);
        expect((await upload(await daemonCredential({ generation: 1 }), { serverRpcKeyEnvelope: lane })).statusCode).toBe(403);
        await client.workMachineExecution.update({ where: { machineId: MACHINE }, data: { frozenAt: new Date() } });
        expect((await upload(current, { serverRpcKeyEnvelope: lane })).statusCode).toBe(403);
        expect(await stored()).toMatchObject({ serverRpcKeyEnvelope: null, serverDataEncryptionKey: null });
        expect(await stored(OTHER_MACHINE)).toMatchObject({ serverRpcKeyEnvelope: null, serverDataEncryptionKey: null });
    });

    it('refuses the account token and a session credential', async () => {
        const lane = envelope();
        expect((await upload(accountToken, { serverRpcKeyEnvelope: lane })).statusCode).toBe(401);
        expect((await upload(accountToken, { serverRpcKeyEnvelope: lane }, OTHER_MACHINE)).statusCode).toBe(401);
        const now = Date.now();
        const session = await auth.workMachineExecutionIssuer!.mint({
            accountId: ACCOUNT, machineId: MACHINE, deviceId: 'new-device', generation: 2,
            purpose: 'session', sessionId: 'any', expiresAt: now + MINUTE,
        }, now);
        expect((await upload(session, { serverRpcKeyEnvelope: lane })).statusCode).toBe(401);
        expect(await stored()).toMatchObject({ serverRpcKeyEnvelope: null });
    });

    it('refuses envelopes that are not canonical version-0 envelopes', async () => {
        const bearer = await daemonCredential();
        expect((await upload(bearer, { serverRpcKeyEnvelope: Buffer.concat([Buffer.from([1]), randomBytes(104)]) })).statusCode).toBe(400);
        expect((await upload(bearer, { serverRpcKeyEnvelope: envelope(), serverDataEncryptionKey: randomBytes(40) })).statusCode).toBe(400);
    });
});
