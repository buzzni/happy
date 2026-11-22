import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import fastify from 'fastify';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { io, type Socket } from 'socket.io-client';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { withSessionPiiModeMigration } from '@/testing/pgliteSessionModeFixture';
import { auth } from '@/app/auth/auth';
import { startSocket } from '@/app/api/socket';
import { executeDaemonRpcLocally } from '@/app/api/socket/managedDaemonRpcRelay';
import { machinesRoutes } from '@/app/api/routes/machinesRoutes';
import { sessionRoutes } from '@/app/api/routes/sessionRoutes';
import { sessionOwnershipRoutes } from '@/app/api/routes/sessionOwnershipRoutes';
import { scriptAutomationRoutes } from '@/app/api/routes/scriptAutomationRoutes';
import { v3SessionRoutes } from '@/app/api/routes/v3SessionRoutes';
import { automationSocketHandler } from '@/app/api/socket/automationSocketHandler';
import { workMachineExecutionRoutes } from '@/app/api/routes/workMachineExecutionRoutes';
import { enableAuthentication, enableSessionScopeAuthentication } from '@/app/api/utils/enableAuthentication';
import { canonicalDigest } from '@/app/managed/canonicalDigest';
import { createControlAssertionVerifier } from '@/app/managed/managedControlAssertion';
import type { Fastify } from '@/app/api/types';
import {
    authenticateWorkMachineSessionSocket,
    authenticateWorkMachineSocket,
    legacySessionSocketAllowed,
    machineSocketIdentityExists,
    workMachineSocketMayAct,
} from '@/app/api/socket/machineSocketAuth';
import { createWorkMachineExecutionTokenIssuer } from '@/app/auth/workMachineExecutionToken';
import * as machineSockets from '@/app/events/findMachineSockets';
import * as authority from './workMachineExecution';
import {
    authorizeWorkMachineExecution,
    freezeWorkMachineExecution,
    permitWorkMachineExecution,
    replaceWorkMachineExecution,
    restoreWorkMachineExecution,
} from './workMachineExecution';
const { workMachineSocketCandidates } = machineSockets;

const accountId = 'work-machine-owner';
const machineId = 'stable-work-machine';
const original = { accountId, machineId, deviceId: 'original-pc', generation: 1 };
const replacement = { accountId, machineId, deviceId: 'replacement-pc', generation: 2 };
let pg: PGlite;
let db: PrismaClient;
const runtime = vi.hoisted(() => ({
    db: null as unknown,
    stop: [] as Array<() => Promise<void>>,
}));
vi.mock('@/storage/db', () => ({ get db() { return runtime.db; } }));
vi.mock('@/utils/shutdown', () => ({
    onShutdown(_name: string, callback: () => Promise<void>) {
        runtime.stop.push(callback);
        return () => {};
    },
}));

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    const { stdout } = await promisify(execFile)(process.execPath, [
        require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty',
        '--to-schema-datamodel', 'prisma/schema.prisma', '--script',
    ], { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' } });
    pg = new PGlite();
    await pg.exec(await withSessionPiiModeMigration(stdout));
    db = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    runtime.db = db;
    await db.account.create({ data: { id: accountId, publicKey: accountId } });
    await db.machine.createMany({
        data: [
            { id: machineId, accountId, metadata: 'encrypted' },
            { id: 'ordinary-machine', accountId, metadata: 'encrypted' },
        ],
    });
    await db.workMachineExecution.create({
        data: { machineId, accountId, deviceId: original.deviceId, generation: original.generation },
    });
    await db.session.create({
        data: { id: 'protected-session', tag: 'protected', accountId, metadata: 'encrypted', workMachineId: machineId },
    });
}, 20_000);

beforeEach(async () => {
    await db.workMachineExecution.update({
        where: { machineId },
        data: { deviceId: original.deviceId, generation: original.generation, frozenAt: null, firstExecutionAt: null },
    });
});

afterAll(async () => {
    await db?.$disconnect();
    await pg?.close();
});

describe('work machine execution authority', () => {
    it('blocks new permits during drain while allowing session writes and MCP admission', async () => {
        await db.$executeRaw`UPDATE "WorkMachineExecution" SET "drainingAt" = now() WHERE "machineId" = ${machineId}`;
        try {
            expect(await permitWorkMachineExecution(db, original, new Date())).toBe(false);
            expect(await authority.authorizeWorkMachineSession(db, { ...original, sessionId: 'protected-session' })).toBe(true);
            const requestId = crypto.randomUUID();
            expect(await authority.admitWorkMachineMcpCall(db, original, requestId)).toBe(true);
            await authority.finishWorkMachineMcpCall(db, original, requestId);
        } finally {
            await db.$executeRaw`UPDATE "WorkMachineExecution" SET "drainingAt" = NULL WHERE "machineId" = ${machineId}`;
        }
    });

    it('does not rewrite the authority row once the first execution is recorded', async () => {
        const version = async () => (await db.$queryRaw<{ xmin: string }[]>`
            SELECT "xmin"::text FROM "WorkMachineExecution" WHERE "machineId" = ${machineId}
        `)[0].xmin;
        const first = new Date('2026-11-22T00:00:00Z');
        expect(await permitWorkMachineExecution(db, original, first)).toBe(true);
        const recorded = await version();
        expect(await permitWorkMachineExecution(db, original, new Date())).toBe(true);
        expect(await version()).toBe(recorded);
        await db.$executeRaw`UPDATE "WorkMachineExecution" SET "drainingAt" = now() WHERE "machineId" = ${machineId}`;
        const draining = await version();
        try {
            expect(await permitWorkMachineExecution(db, original, new Date())).toBe(false);
            expect(await permitWorkMachineExecution(db, original, new Date(), true)).toBe(true);
            expect(await version()).toBe(draining);
        } finally {
            await db.$executeRaw`UPDATE "WorkMachineExecution" SET "drainingAt" = NULL WHERE "machineId" = ${machineId}`;
        }
        expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt).toEqual(first);
    });

    it('allows read-only preview during drain without recording first execution, but refuses it when frozen', async () => {
        const now = Date.now();
        const socket = { id: 'reader', data: { workMachineExecution: { ...original, purpose: 'daemon', expiresAt: now + 60_000 } } };
        await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
        try {
            expect(await machineSockets.permitMachineDispatchSockets(db, accountId, machineId, [socket], now, true)).toEqual([socket]);
            expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt).toBeNull();
            await freezeWorkMachineExecution(db, original);
            expect(await machineSockets.permitMachineDispatchSockets(db, accountId, machineId, [socket], now, true)).toEqual([]);
        } finally {
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
        }
    });

    it('allows read-only daemon RPC during drain without recording execution and rejects writes and frozen reads', async () => {
        const now = Date.now();
        const emitted: string[] = [];
        const socket = { data: { workMachineExecution: { ...original, purpose: 'daemon', expiresAt: now + 60_000 } },
            timeout: () => ({ emitWithAck: async (_event: string, request: { method: string }) => { emitted.push(request.method); return {}; } }) };
        const invoke = async (method: string) => executeDaemonRpcLocally({
            io: { sockets: { sockets: new Map([['socket', socket]]) } } as never,
            request: { requestId: crypto.randomUUID(), targetSocketId: 'socket', method: `${machineId}:${method}`, params: {}, timeoutMs: 1000 },
            onResult: () => {}, deps: { allowed: (async () => true) as never, now: () => now },
        });
        await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
        try {
            expect((await invoke('readFile')).refused).toBe(false);
            expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt).toBeNull();
            expect((await invoke('writeFile')).refused).toBe(true);
            await freezeWorkMachineExecution(db, original);
            expect((await invoke('readFile')).refused).toBe(true);
            expect(emitted).toEqual([`${machineId}:readFile`]);
        } finally {
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
        }
    });

    it('blocks handoff until admitted connector work has a confirmed outcome', async () => {
        const requestId = crypto.randomUUID();
        const secondId = crypto.randomUUID();
        await expect(authority.admitWorkMachineMcpCall(db, original, requestId)).resolves.toBe(true);
        await expect(authority.admitWorkMachineMcpCall(db, original, requestId)).resolves.toBe(false);
        expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt).not.toBeNull();
        expect(await freezeWorkMachineExecution(db, original)).toBe(true);
        await expect(authority.admitWorkMachineMcpCall(db, original, secondId)).resolves.toBe(false);
        await expect(replaceWorkMachineExecution(db, original, replacement.deviceId)).resolves.toBe(false);
        await authority.finishWorkMachineMcpCall(db, { ...original, generation: 2 }, requestId);
        await expect(replaceWorkMachineExecution(db, original, replacement.deviceId)).resolves.toBe(false);
        await authority.finishWorkMachineMcpCall(db, original, requestId);
        await authority.finishWorkMachineMcpCall(db, original, requestId);
        await expect(replaceWorkMachineExecution(db, original, replacement.deviceId)).resolves.toBe(true);
        await expect(authority.admitWorkMachineMcpCall(db, original, secondId)).resolves.toBe(false);
        await expect(authority.admitWorkMachineMcpCall(db, replacement, secondId)).resolves.toBe(true);
        await authority.finishWorkMachineMcpCall(db, replacement, secondId);
    });

    it('rechecks a preview candidate at dispatch and only permits one active socket', async () => {
        const now = Date.now();
        const socket = (id: string, device: typeof original, connectedAt: number) => ({
            id, data: { connectedAt, workMachineExecution: { ...device, purpose: 'daemon', expiresAt: now + 60_000 } },
        });
        const stale = socket('stale', original, now);
        const older = socket('older', replacement, now - 100);
        const current = socket('current', replacement, now);
        expect(await freezeWorkMachineExecution(db, original)).toBe(true);
        expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
        await expect(machineSockets.permitMachineDispatchSockets(db, accountId, machineId, [stale], now)).resolves.toEqual([]);
        expect(await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } }))
            .toMatchObject({ firstExecutionAt: null });
        await expect(machineSockets.permitMachineDispatchSockets(db, accountId, machineId, [current, older], now)).resolves.toEqual([current]);
        expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe(false);
        const ordinary = [{ id: 'ordinary', data: {} }];
        await expect(machineSockets.permitMachineDispatchSockets(db, accountId, 'ordinary-machine', ordinary, now)).resolves.toEqual(ordinary);
        await expect(machineSockets.permitMachineDispatchSockets(db, accountId, machineId, ordinary, now)).resolves.toEqual([]);
    });

    it('uses the registered device generation and keeps unrelated machines on their existing authentication path', async () => {
        await expect(machineSocketIdentityExists(db, accountId, 'ordinary-machine')).resolves.toBe(true);
        await expect(machineSocketIdentityExists(db, accountId, machineId)).resolves.toBe(false);
        await expect(authorizeWorkMachineExecution(db, original)).resolves.toBe(true);
        await expect(authorizeWorkMachineExecution(db, replacement)).resolves.toBe(false);

        await expect(freezeWorkMachineExecution(db, original)).resolves.toBe(true);
        await expect(authorizeWorkMachineExecution(db, original)).resolves.toBe(false);
        await expect(replaceWorkMachineExecution(db, original, replacement.deviceId)).resolves.toBe(true);
        await expect(replaceWorkMachineExecution(db, original, 'late-device')).resolves.toBe(false);
        await expect(authorizeWorkMachineExecution(db, original)).resolves.toBe(false);
        await expect(authorizeWorkMachineExecution(db, { ...replacement, deviceId: original.deviceId })).resolves.toBe(false);
        await expect(authorizeWorkMachineExecution(db, replacement)).resolves.toBe(true);
        await expect(machineSocketIdentityExists(db, accountId, machineId)).resolves.toBe(false);
    });

    it('makes the replacement first execution permit and rollback mutually exclusive', async () => {
        await db.workMachineExecution.update({
            where: { machineId },
            data: { deviceId: replacement.deviceId, generation: replacement.generation, frozenAt: null, firstExecutionAt: null },
        });
        const [allowed, restored] = await Promise.all([
            permitWorkMachineExecution(db, replacement, new Date('2026-11-22T00:00:00Z')),
            restoreWorkMachineExecution(db, replacement, original.deviceId),
        ]);

        expect(Number(allowed) + Number(restored)).toBe(1);
        const current = await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } });
        expect(current.deviceId).toBe(allowed ? replacement.deviceId : original.deviceId);
        expect(current.generation).toBe(allowed ? replacement.generation : replacement.generation + 1);
        expect(current.firstExecutionAt !== null).toBe(allowed);
        await expect(permitWorkMachineExecution(db, original, new Date())).resolves.toBe(false);
    });

    it('rejects a connected old daemon, its reconnect, and a user socket claiming machine RPCs after handoff', async () => {
        const now = 1_800_000_000_000;
        const issuer = await createWorkMachineExecutionTokenIssuer('work-machine-socket-tests');
        const oldToken = await issuer.mint({ ...original, purpose: 'daemon', expiresAt: now + 60_000 }, now);
        const newToken = await issuer.mint({ ...replacement, purpose: 'daemon', expiresAt: now + 60_000 }, now);
        const connected = await authenticateWorkMachineSocket(db, issuer, oldToken, machineId, now);
        expect(connected).toMatchObject(original);
        await expect(workMachineSocketMayAct(db, {
            accountId, socketMachineId: machineId, claims: connected, event: 'rpc-register',
            payload: { method: `${machineId}:example` }, now,
        })).resolves.toBe(true);

        expect(await freezeWorkMachineExecution(db, original)).toBe(true);
        expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
        await expect(authenticateWorkMachineSocket(db, issuer, oldToken, machineId, now)).resolves.toBeNull();
        await expect(authenticateWorkMachineSocket(db, issuer, newToken, 'ordinary-machine', now)).resolves.toBeNull();
        await expect(authenticateWorkMachineSocket(db, issuer, newToken, machineId, now)).resolves.toMatchObject(replacement);
        for (const socket of [
            { socketMachineId: machineId, claims: connected },
            { socketMachineId: undefined, claims: null },
            { socketMachineId: 'ordinary-machine', claims: null },
        ]) {
            await expect(workMachineSocketMayAct(db, {
                accountId, ...socket, event: 'rpc-register', payload: { method: `${machineId}:example` }, now,
            })).resolves.toBe(false);
        }
        await expect(workMachineSocketMayAct(db, {
            accountId, socketMachineId: undefined, claims: null, event: 'rpc-register',
            payload: { method: 'ordinary-machine:example' }, now,
        })).resolves.toBe(true);
        await expect(workMachineSocketMayAct(db, {
            accountId, socketMachineId: undefined, claims: null, event: 'message',
            payload: { sid: 'ordinary-session' }, now,
        })).resolves.toBe(true);
    });

    it('rejects legacy and stale session sockets while scoping current agent events to the original conversation', async () => {
        const now = 1_800_000_000_000;
        const sessionId = 'protected-session';
        const issuer = await createWorkMachineExecutionTokenIssuer('work-machine-session-socket-tests');
        const mint = (device: typeof original) => issuer.mint({
            ...device, purpose: 'session', sessionId, expiresAt: now + 60_000,
        }, now);
        const oldToken = await mint(original);
        const newToken = await mint(replacement);
        const oldSocket = await authenticateWorkMachineSessionSocket(db, issuer, oldToken, sessionId, now);
        expect(oldSocket).toMatchObject({ deviceId: original.deviceId, sessionId });
        expect(await legacySessionSocketAllowed(db, accountId, sessionId)).toBe(false);
        const check = (claims: typeof oldSocket, event: string, payload: Record<string, string>, browser = false) =>
            workMachineSocketMayAct(db, {
                accountId, socketMachineId: undefined, socketSessionId: claims?.sessionId,
                workMachineBrowser: browser, claims, event, payload, now,
            });
        expect(await check(oldSocket, 'update-state', { sid: sessionId })).toBe(true);
        expect(await check(null, 'message', { sid: sessionId })).toBe(false);
        expect(await check(null, 'message', { sid: sessionId }, true)).toBe(false);
        expect(await check(null, 'rpc-call', { method: `${sessionId}:permission` }, true)).toBe(true);
        expect(await check(null, 'rpc-call', { method: `${sessionId}:permission` })).toBe(false);

        expect(await freezeWorkMachineExecution(db, original)).toBe(true);
        expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
        expect(await authenticateWorkMachineSessionSocket(db, issuer, oldToken, sessionId, now)).toBeNull();
        expect(await check(oldSocket, 'update-state', { sid: sessionId })).toBe(false);
        const newSocket = await authenticateWorkMachineSessionSocket(db, issuer, newToken, sessionId, now);
        expect(newSocket).toMatchObject({ deviceId: replacement.deviceId, sessionId });
        expect(await check(newSocket, 'update-state', { sid: sessionId })).toBe(true);
        expect(await check(newSocket, 'update-state', { sid: 'other-session' })).toBe(false);
        expect(await check(null, 'provider-usage-report', { sessionId })).toBe(false);
        expect(await check(oldSocket, 'provider-usage-report', { sessionId })).toBe(false);
        expect(await check(newSocket, 'provider-usage-report', { sessionId: 'other-session' })).toBe(false);
        expect(await check(newSocket, 'provider-usage-report', { sessionId })).toBe(true);
    });

    it('does not route requests to an older, newer-connected, or unverified device', async () => {
        const now = 1_800_000_000_000;
        expect(await freezeWorkMachineExecution(db, original)).toBe(true);
        expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
        const sockets = [
            { id: 'current', data: { connectedAt: 1, workMachineExecution: { ...replacement, purpose: 'daemon', expiresAt: now + 60_000 } } },
            { id: 'reconnected', data: { connectedAt: 3, workMachineExecution: { ...original, purpose: 'daemon', expiresAt: now + 60_000 } } },
            { id: 'legacy', data: { connectedAt: 4 } },
            { id: 'expired', data: { connectedAt: 5, workMachineExecution: { ...replacement, purpose: 'daemon', expiresAt: now } } },
        ];
        expect((await workMachineSocketCandidates(db, accountId, machineId, sockets, now)).map(socket => socket.id))
            .toEqual(['current']);
        expect((await workMachineSocketCandidates(db, accountId, 'ordinary-machine', sockets, now)).map(socket => socket.id))
            .toEqual(['legacy']);
        expect(await freezeWorkMachineExecution(db, replacement)).toBe(true);
        expect(await workMachineSocketCandidates(db, accountId, machineId, sockets, now)).toEqual([]);
    });

    it('keeps the machine id but rejects both a live old socket and a fresh connection with its old grant', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        const app = fastify();
        const clients: Socket[] = [];
        try {
            await auth.init();
            startSocket(app as unknown as Fastify);
            const url = await app.listen({ host: '127.0.0.1', port: 0 });
            const connect = (token: string, sessionId?: string) => {
                const socket = io(url, {
                    autoConnect: false, forceNew: true, path: '/v1/updates',
                    transports: ['websocket'], reconnection: false,
                    auth: sessionId ? { token, sessionId, clientType: 'session-scoped' }
                        : { token, machineId, clientType: 'machine-scoped' },
                });
                clients.push(socket);
                return new Promise<Socket>((resolve, reject) => {
                    socket.once('connect', () => resolve(socket));
                    socket.once('connect_error', reject);
                    socket.connect();
                });
            };
            const mint = (device: typeof original) => {
                const now = Date.now();
                return auth.workMachineExecutionIssuer!.mint({ ...device, purpose: 'daemon', expiresAt: now + 60_000 }, now);
            };
            const oldToken = await mint(original);
            const oldSocket = await connect(oldToken);
            const sessionId = 'protected-session';
            const now = Date.now();
            const sessionToken = await auth.workMachineExecutionIssuer!.mint({
                ...original, purpose: 'session', sessionId, expiresAt: now + 60_000,
            }, now);
            const oldSession = await connect(sessionToken, sessionId);
            const update = (socket: Socket, metadata: string, expectedVersion: number) =>
                socket.timeout(500).emitWithAck('machine-update-metadata', {
                    machineId, metadata, expectedVersion,
                });

            const prior = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
            await expect(update(oldSocket, 'old-current', prior.metadataVersion)).resolves.toMatchObject({ result: 'success' });
            let guardPassed!: () => void;
            let sessionGuardPassed!: () => void;
            let continueWrite!: () => void;
            const afterGuard = new Promise<void>(resolve => { guardPassed = resolve; });
            const afterSessionGuard = new Promise<void>(resolve => { sessionGuardPassed = resolve; });
            const beforeWrite = new Promise<void>(resolve => { continueWrite = resolve; });
            runtime.db = new Proxy(db, {
                get(target, key) {
                    if (key === 'machine') {
                        const delegate = target.machine;
                        return new Proxy(delegate, {
                            get(model, method) {
                                if (method !== 'findFirst') return Reflect.get(model, method);
                                return async (...args: Parameters<typeof delegate.findFirst>) => {
                                    const machine = await delegate.findFirst(...args);
                                    guardPassed();
                                    await beforeWrite;
                                    return machine;
                                };
                            },
                        });
                    }
                    if (key === 'session') {
                        const delegate = target.session;
                        return new Proxy(delegate, {
                            get(model, method) {
                                if (method !== 'findUnique') return Reflect.get(model, method);
                                return async (...args: Parameters<typeof delegate.findUnique>) => {
                                    const session = await delegate.findUnique(...args);
                                    sessionGuardPassed();
                                    await beforeWrite;
                                    return session;
                                };
                            },
                        });
                    }
                    const value = Reflect.get(target, key, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            const inFlight = update(oldSocket, 'in-flight-write', prior.metadataVersion + 1);
            const inFlightSession = oldSession.timeout(500).emitWithAck('update-state', {
                sid: sessionId, agentState: 'stale-agent-state', expectedVersion: 0,
            });
            try {
                await Promise.all([afterGuard, afterSessionGuard]);
                expect(await freezeWorkMachineExecution(db, original)).toBe(true);
                expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            } finally {
                runtime.db = db;
                continueWrite();
            }
            await expect(inFlight).resolves.toMatchObject({ result: 'error' });
            await expect(inFlightSession).resolves.toMatchObject({ result: 'error' });
            expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).agentState).toBeNull();
            await expect(update(oldSocket, 'stale-write', prior.metadataVersion + 1)).rejects.toThrow();
            await expect(connect(oldToken)).rejects.toThrow('Invalid authentication token');
            await expect(connect(await auth.createToken(accountId))).rejects.toThrow('Invalid machine identity');
            const newSocket = await connect(await mint(replacement));
            await expect(update(newSocket, 'new-current', prior.metadataVersion + 1)).resolves.toMatchObject({ result: 'success' });

            const machine = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
            expect(machine.metadata).toBe('new-current');
            expect(machine.metadataVersion).toBe(prior.metadataVersion + 2);
        } finally {
            for (const client of clients) client.disconnect();
            for (const stop of runtime.stop.splice(0)) await stop();
            await app.close();
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    }, 15_000);

    it('leaves scheduled and script automation work pending on a draining or frozen work machine', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        vi.stubEnv('SAYCODE_AUTOMATION_ENABLED', 'true');
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const project = await db.project.create({ data: { accountId, name: 'automation-handoff' } });
        const automation = await db.automation.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, payloadVersion: 3,
            payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer', viewerKeyVersion: 1,
            viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
        } });
        await db.scriptArtifact.create({ data: { id: 'handoff-artifact', projectId: project.id, digest: 'digest', encrypted: {} } });
        await db.scriptAutomationRevision.create({ data: {
            automationId: automation.id, revision: 1, artifactId: 'handoff-artifact', digest: 'digest',
            payloadCiphertext: 'encrypted', admission: {}, ready: true,
        } });
        const run = await db.scriptInvocation.create({ data: {
            id: 'handoff-run', automationId: automation.id, revision: 1, generation: 1, trigger: 'manual',
            requestedBy: accountId, idempotencyKey: 'handoff', bodyHash: 'hash', snapshot: { machineId, machineAccountId: accountId },
            inputCiphertext: 'encrypted', createdAt: Date.now(),
        } });
        const handlers = new Map<string, (data: unknown, callback: (result: unknown) => void) => Promise<void>>();
        automationSocketHandler(accountId, machineId, { on: (event: string, handler: never) => handlers.set(event, handler) } as never);
        const socketClaim = () => new Promise(resolve => void handlers.get('automation-claim')!(
            { automationId: automation.id, generation: 1, scheduledFor: Date.now() }, resolve,
        ));
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            scriptAutomationRoutes(app as unknown as Fastify, { enabled: () => true, transaction: work => db.$transaction(work) });
            const bearer = await auth.createToken(accountId);
            const httpClaim = () => app.inject({
                method: 'POST', url: `/v1/machines/${machineId}/script-automations/${automation.id}/claim`, payload: {},
                headers: { authorization: `Bearer ${bearer}` },
            });
            for (const data of [{ drainingAt: new Date() }, { frozenAt: new Date() }]) {
                await db.workMachineExecution.update({ where: { machineId }, data });
                expect((await httpClaim()).statusCode).toBe(403);
                expect(await socketClaim()).toEqual({ ok: false, error: 'forbidden' });
            }
            expect(await db.scriptInvocation.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'QUEUED', claimHash: null });
            expect(await db.automationRun.count({ where: { automationId: automation.id } })).toBe(0);
        } finally {
            await app.close();
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
            await db.project.delete({ where: { id: project.id } });
            vi.unstubAllEnvs();
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });

    it('drains, freezes, hands off and restores a work machine through idempotent control routes', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const studio = generateKeyPairSync('ed25519');
        const kid = 'handoff-key';
        const audience = 'handoff-happy';
        const verifier = createControlAssertionVerifier({
            audience,
            verifierKeys: JSON.stringify({ [kid]: studio.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') }),
        });
        const device = () => {
            const keys = generateKeyPairSync('ed25519');
            const der = keys.publicKey.export({ format: 'der', type: 'spki' });
            return { keys, publicKey: der.toString('base64url'), id: createHash('sha256').update(der).digest('base64url') };
        };
        const source = device();
        const target = device();
        const migrating = 'migrating-machine';
        const sessionId = 'migrating-session';
        const envelope = (fill: number) => { const bytes = Buffer.alloc(105, fill); bytes[0] = 0; return bytes; };
        await db.machine.create({ data: { id: migrating, accountId, metadata: 'encrypted', dataEncryptionKey: envelope(1) } });
        await db.workMachineExecution.create({ data: { machineId: migrating, accountId, deviceId: source.id, generation: 1 } });
        await db.session.create({ data: { id: sessionId, tag: sessionId, accountId, metadata: 'encrypted', workMachineId: migrating } });
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            enableSessionScopeAuthentication(app as unknown as Fastify, () => null);
            workMachineExecutionRoutes(app as unknown as Fastify, () => verifier);
            v3SessionRoutes(app as unknown as Fastify);
            const bearer = await auth.createToken(accountId);
            const accountTokenDigest = createHash('sha256').update(bearer).digest('hex');
            const control = (action: string, payload: object, op = `work-machine-${action}`) => {
                const now = Date.now();
                const bytes = Buffer.from(JSON.stringify({
                    kid, aud: audience, purpose: 'happy-managed-control', op,
                    bodyDigest: canonicalDigest({ accountTokenDigest, machineId: migrating, ...payload }),
                    iat: now, exp: now + 5000,
                }));
                const route = action === 'mcp-reconcile' ? 'mcp-reconcile' : `execution-${action}`;
                return app.inject({
                    method: 'POST', url: `/v1/work-machines/${migrating}/${route}`, payload,
                    headers: {
                        authorization: `Bearer ${bearer}`,
                        'x-happy-control-assertion': `${bytes.toString('base64url')}.${sign(null, bytes, studio.privateKey).toString('base64url')}`,
                    },
                });
            };
            const state = async () => (await control('state', {}, 'work-machine-execution-state')).json();
            const handoffProof = (
                signer: ReturnType<typeof device>, tag: 'replace' | 'restore', generation: number, nextDeviceId: string, key: Buffer,
            ) => {
                const issuedAt = Date.now();
                const digest = createHash('sha256').update(key).digest('base64url');
                const scope = [`happy-work-machine-${tag}-v1`, migrating, generation, nextDeviceId, digest, issuedAt];
                return {
                    issuedAt, publicKey: signer.publicKey,
                    signature: sign(null, Buffer.from(JSON.stringify(scope)), signer.keys.privateKey).toString('base64url'),
                };
            };
            const replaceBody = (generation: number, key: Buffer, signer = target, signedKey = key) => ({
                deviceId: source.id, generation, replacementDeviceId: target.id, dataEncryptionKey: key.toString('base64'),
                proof: handoffProof(signer, 'replace', generation, target.id, signedKey),
            });
            const restoreBody = (generation: number, key: Buffer) => ({
                deviceId: target.id, generation, originalDeviceId: source.id, dataEncryptionKey: key.toString('base64'),
                proof: handoffProof(source, 'restore', generation, source.id, key),
            });
            const sessionToken = (deviceId: string, generation: number) => {
                const now = Date.now();
                return auth.workMachineExecutionIssuer!.mint({
                    accountId, machineId: migrating, deviceId, generation, sessionId, purpose: 'session', expiresAt: now + 60_000,
                }, now);
            };
            const permit = async (token: string) => (await app.inject({
                method: 'POST', url: `/v1/sessions/${sessionId}/work-machine-permit`, headers: { authorization: `Bearer ${token}` },
            })).statusCode;
            const write = async (token: string, localId: string) => (await app.inject({
                method: 'POST', url: `/v3/sessions/${sessionId}/messages`, headers: { authorization: `Bearer ${token}` },
                payload: { messages: [{ content: 'encrypted-body', localId }] },
            })).statusCode;
            const at = (generation: number, deviceId = source.id) => ({ deviceId, generation });

            expect(await state()).toEqual({
                mode: 'device', deviceId: source.id, generation: 1, frozen: false, draining: false, firstExecution: false, openMcpCalls: [],
            });
            const unsigned = await app.inject({
                method: 'POST', url: `/v1/work-machines/${migrating}/execution-drain`, payload: at(1),
                headers: { authorization: `Bearer ${bearer}` },
            });
            expect(unsigned.statusCode).toBe(403);
            expect((await control('drain', at(1), 'work-machine-freeze')).statusCode).toBe(403);
            expect((await control('freeze', at(1))).statusCode).toBe(409);
            expect((await control('drain', at(2))).statusCode).toBe(409);

            // Cancel before the handoff: drain, freeze, then resume in the same generation.
            const drained = { deviceId: source.id, generation: 1, draining: true, frozen: false };
            const frozen = { ...drained, frozen: true };
            const active = { ...drained, draining: false };
            for (const [action, expected] of [['drain', drained], ['freeze', frozen], ['resume', active]] as const) {
                const first = await control(action, at(1));
                expect(first.statusCode).toBe(200);
                expect(first.json()).toEqual(expected);
                const retry = await control(action, at(1));
                expect(retry.statusCode).toBe(200);
                expect(retry.json()).toEqual(expected);
            }

            const sourceToken = await sessionToken(source.id, 1);
            expect((await control('drain', at(1))).json()).toEqual(drained);
            expect(await permit(sourceToken)).toBe(403);
            expect(await write(sourceToken, 'in-turn-reply')).toBe(200);
            const requestId = crypto.randomUUID();
            expect(await authority.admitWorkMachineMcpCall(db, { accountId, machineId: migrating, ...at(1) }, requestId)).toBe(true);
            const draining = await state();
            expect(draining).toMatchObject({ draining: true, frozen: false, firstExecution: true });
            expect(draining.openMcpCalls).toEqual([{ requestId, admittedAt: expect.any(Number) }]);
            expect((await control('mcp-reconcile', { ...at(1), requestId })).statusCode).toBe(409);
            expect((await control('freeze', at(1))).json()).toEqual(frozen);
            expect(await write(sourceToken, 'after-freeze')).toBe(403);

            const nextKey = envelope(2);
            expect((await control('replace', replaceBody(1, nextKey))).statusCode).toBe(409);
            expect((await db.machine.findUniqueOrThrow({ where: { id: migrating } })).dataEncryptionKey).toEqual(new Uint8Array(envelope(1)));
            const reconciled = await control('mcp-reconcile', { ...at(1), requestId });
            expect(reconciled.statusCode).toBe(200);
            expect(reconciled.json()).toEqual({ requestId, reconciledAt: expect.any(Number) });
            expect((await control('mcp-reconcile', { ...at(1), requestId })).json()).toEqual(reconciled.json());
            expect((await control('mcp-reconcile', { ...at(1), requestId: crypto.randomUUID() })).statusCode).toBe(404);
            expect((await state()).openMcpCalls).toEqual([]);

            expect((await control('replace', replaceBody(1, nextKey, source))).statusCode).toBe(403);
            expect((await control('replace', replaceBody(1, nextKey, target, envelope(3)))).statusCode).toBe(403);
            expect((await control('replace', { ...replaceBody(1, nextKey), dataEncryptionKey: 'not-an-envelope' })).statusCode).toBe(400);
            const before = await db.machine.findUniqueOrThrow({ where: { id: migrating } });
            const replaced = await control('replace', replaceBody(1, nextKey));
            expect(replaced.statusCode).toBe(200);
            expect(replaced.json()).toEqual({ deviceId: target.id, generation: 2 });
            const retried = await control('replace', replaceBody(1, nextKey));
            expect(retried.statusCode).toBe(200);
            expect(retried.json()).toEqual(replaced.json());
            expect((await control('replace', replaceBody(1, envelope(4)))).statusCode).toBe(409);
            const after = await db.machine.findUniqueOrThrow({ where: { id: migrating } });
            expect(after.dataEncryptionKey).toEqual(new Uint8Array(nextKey));
            expect(after.metadataVersion).toBe(before.metadataVersion + 1);
            expect(after.daemonStateVersion).toBe(before.daemonStateVersion + 1);
            expect(await state()).toEqual({
                mode: 'device', deviceId: target.id, generation: 2, frozen: false, draining: false, firstExecution: false, openMcpCalls: [],
            });
            expect(await permit(sourceToken)).toBe(403);

            // Roll back before the replacement runs anything.
            const originalKey = envelope(5);
            const restored = await control('restore', restoreBody(2, originalKey));
            expect(restored.statusCode).toBe(200);
            expect(restored.json()).toEqual({ deviceId: source.id, generation: 3 });
            expect((await control('restore', restoreBody(2, originalKey))).json()).toEqual(restored.json());
            expect((await db.machine.findUniqueOrThrow({ where: { id: migrating } })).dataEncryptionKey).toEqual(new Uint8Array(originalKey));

            // Hand off again; once the replacement has a first execution permit, rollback is refused.
            for (const action of ['drain', 'freeze'] as const) expect((await control(action, at(3))).statusCode).toBe(200);
            expect((await control('replace', replaceBody(3, envelope(6)))).json()).toEqual({ deviceId: target.id, generation: 4 });
            expect(await permit(await sessionToken(target.id, 4))).toBe(204);
            expect((await state()).firstExecution).toBe(true);
            expect((await control('restore', restoreBody(4, envelope(7)))).statusCode).toBe(409);
            expect((await state()).deviceId).toBe(target.id);
        } finally {
            await app.close();
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });

    it('issues scoped credentials only with both control-plane proof and current device authority', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        vi.stubEnv('HAPPY_SESSION_OWNERSHIP_ENABLED', '1');
        vi.stubEnv('HAPPY_SESSION_OWNERSHIP_ISSUER', 'https://studio.example');
        vi.stubEnv('HAPPY_SESSION_OWNERSHIP_AUDIENCE', 'https://happy.example');
        vi.stubEnv('HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS', JSON.stringify({
            ['a'.repeat(64)]: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
        }));
        const kid = 'test-key';
        const audience = 'test-happy';
        const verifier = createControlAssertionVerifier({
            audience,
            verifierKeys: JSON.stringify({ [kid]: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') }),
        });
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            enableSessionScopeAuthentication(app as unknown as Fastify, () => null);
            workMachineExecutionRoutes(app as unknown as Fastify, () => verifier);
            machinesRoutes(app as unknown as Fastify);
            sessionRoutes(app as unknown as Fastify);
            sessionOwnershipRoutes(app as unknown as Fastify);
            scriptAutomationRoutes(app as unknown as Fastify, { enabled: () => true, transaction: work => db.$transaction(work) });
            const bearer = await auth.createToken(accountId);
            const device = { deviceId: original.deviceId, generation: original.generation };
            const accountTokenDigest = createHash('sha256').update(bearer).digest('hex');
            function proof(payload: object, op = 'work-machine-execution-grant', target = machineId) {
                const now = Date.now();
                const bytes = Buffer.from(JSON.stringify({
                    kid, aud: audience, purpose: 'happy-managed-control', op,
                    bodyDigest: canonicalDigest({ accountTokenDigest, machineId: target, ...payload }),
                    iat: now, exp: now + 5000,
                }));
                return `${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`;
            }
            const state = (id: string, assertion?: string) => app.inject({
                method: 'POST', url: `/v1/work-machines/${id}/execution-state`, payload: {},
                headers: { authorization: `Bearer ${bearer}`, ...(assertion ? { 'x-happy-control-assertion': assertion } : {}) },
            });
            const stateProof = (id: string) => proof({}, 'work-machine-execution-state', id);
            expect((await state(machineId)).statusCode).toBe(403);
            expect((await state(machineId, proof(device))).statusCode).toBe(403);
            expect((await state('ordinary-machine', stateProof(machineId))).statusCode).toBe(403);
            expect((await state('ordinary-machine', stateProof('ordinary-machine'))).json()).toEqual({ mode: 'legacy' });
            expect((await state(machineId, stateProof(machineId))).json())
                .toEqual({
                    mode: 'device', deviceId: original.deviceId, generation: 1,
                    frozen: false, draining: false, firstExecution: false, openMcpCalls: [],
                });
            const mintState = (targetMachineId: string, signedTarget: string = targetMachineId) => app.inject({
                method: 'POST',
                url: '/v1/work-machines/mcp-mint-state',
                payload: { targetMachineId },
                headers: {
                    authorization: `Bearer ${bearer}`,
                    'x-happy-control-assertion': proof({ targetMachineId: signedTarget }, 'work-machine-mcp-mint-state', 'mcp-mint-state'),
                },
            });
            expect((await mintState('ordinary-machine')).json()).toEqual({ fenced: true });
            expect((await mintState(machineId)).json()).toEqual({ fenced: true, target: { ...original, frozen: false } });
            expect((await mintState('ordinary-machine', machineId)).statusCode).toBe(403);
            const issue = (payload: object, assertion?: string) => app.inject({
                method: 'POST', url: `/v1/work-machines/${machineId}/execution-grant`, payload,
                headers: {
                    authorization: `Bearer ${bearer}`,
                    ...(assertion ? { 'x-happy-control-assertion': assertion } : {}),
                },
            });
            expect((await issue(device, proof(device))).statusCode).toBe(404);
            const issuer = auth.workMachineExecutionIssuer!;
            const expiresAt = Date.now() + 60_000;
            const daemonToken = await issuer.mint({ ...original, purpose: 'daemon', expiresAt }, Date.now());
            expect(await issuer.verify(daemonToken, 'daemon', Date.now())).toMatchObject(original);
            const readMachine = (id: string) => app.inject({
                method: 'GET', url: `/v1/machines/${id}`, headers: { authorization: `Bearer ${daemonToken}` },
            });
            expect((await readMachine(machineId)).statusCode).toBe(200);
            expect((await readMachine('ordinary-machine')).statusCode).toBe(403);
            const readAs = (id: string, token: string) => app.inject({
                method: 'GET', url: `/v1/machines/${id}`, headers: { authorization: `Bearer ${token}` },
            });
            expect((await readAs(machineId, bearer)).statusCode).toBe(403);
            expect((await readAs('ordinary-machine', bearer)).statusCode).toBe(200);
            const browser = await auth.createBrowserSyncToken(accountId, Date.now(), undefined, true);
            expect(browser).not.toBeNull();
            expect((await readAs(machineId, browser!.token)).statusCode).toBe(200);
            const machineIdentity = (id: string, token: string) => app.inject({
                method: 'POST', url: '/v1/session-ownership/machine-identity', payload: { machineId: id },
                headers: { authorization: `Bearer ${token}` },
            });
            expect((await machineIdentity(machineId, bearer)).statusCode).toBe(403);
            expect((await machineIdentity('ordinary-machine', bearer)).json().machine).toEqual({ machineId: 'ordinary-machine', accountId });
            expect((await machineIdentity(machineId, daemonToken)).json().machine).toEqual({ machineId, accountId });
            expect((await machineIdentity(machineId, browser!.token)).statusCode).toBe(403);
            const listScripts = (id: string) => app.inject({
                method: 'GET', url: `/v1/machines/${id}/script-automations`, headers: { authorization: `Bearer ${bearer}` },
            });
            expect((await listScripts(machineId)).statusCode).toBe(403);
            expect((await listScripts('ordinary-machine')).statusCode).toBe(200);
            const sessionToken = await issuer.mint({ ...original, sessionId: 'protected-session', purpose: 'session', expiresAt }, Date.now());
            expect(await issuer.verify(sessionToken, 'session', Date.now()))
                .toMatchObject({ ...original, sessionId: 'protected-session' });
            const mcpScopePayload = { sessionId: 'protected-session', executionToken: sessionToken };
            const readMcpScope = (payload: typeof mcpScopePayload, assertedPayload = payload) => app.inject({
                method: 'POST', url: `/v1/work-machines/${machineId}/mcp-execution-scope`, payload,
                headers: { authorization: `Bearer ${bearer}`, 'x-happy-control-assertion': proof(assertedPayload, 'work-machine-mcp-execution-scope') },
            });
            expect((await readMcpScope({ ...mcpScopePayload, sessionId: 'other-session' })).statusCode).toBe(403);
            expect((await readMcpScope({ ...mcpScopePayload, executionToken: daemonToken })).statusCode).toBe(403);
            expect((await readMcpScope(mcpScopePayload, { ...mcpScopePayload, sessionId: 'other-session' })).statusCode).toBe(403);
            expect((await readMcpScope(mcpScopePayload)).json()).toEqual(original);
            const call = { ...device, accountId, requestId: '68561c76-194d-4c96-858f-b04567db3221' };
            const signedCall = (action: 'admit' | 'finish', assertion?: string, payload = call) => app.inject({
                method: 'POST', url: `/v1/work-machines/${machineId}/mcp-${action}`, payload,
                headers: { authorization: `Bearer ${bearer}`, ...(assertion ? { 'x-happy-control-assertion': assertion } : {}) },
            });
            expect((await signedCall('admit')).statusCode).toBe(403);
            expect((await signedCall('admit', proof(call, 'work-machine-mcp-finish'))).statusCode).toBe(403);
            expect((await signedCall('admit', proof({ ...call, generation: 2 }, 'work-machine-mcp-admit'))).statusCode).toBe(403);
            const crossAccount = { ...call, accountId: 'different-account' };
            expect((await signedCall('admit', proof(crossAccount, 'work-machine-mcp-admit'), crossAccount)).statusCode).toBe(403);
            expect((await signedCall('admit', proof(call, 'work-machine-mcp-admit'))).statusCode).toBe(204);
            expect(await freezeWorkMachineExecution(db, original)).toBe(true);
            expect((await mintState('ordinary-machine')).json()).toEqual({ fenced: true });
            expect((await readMcpScope(mcpScopePayload)).statusCode).toBe(403);
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(false);
            expect((await signedCall('finish', proof(call, 'work-machine-mcp-admit'))).statusCode).toBe(403);
            expect((await signedCall('finish', proof(call, 'work-machine-mcp-finish'))).statusCode).toBe(204);
            expect(await db.workMachineMcpCall.count({ where: { requestId: call.requestId, completedAt: { not: null } } })).toBe(1);
            expect((await state(machineId, stateProof(machineId))).json())
                .toEqual({
                    mode: 'device', deviceId: original.deviceId, generation: 1,
                    frozen: true, draining: false, firstExecution: true, openMcpCalls: [],
                });
            expect((await readMachine(machineId)).statusCode).toBe(403);
            expect((await machineIdentity(machineId, daemonToken)).statusCode).toBe(403);

            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            const newSessionBearer = await auth.workMachineExecutionIssuer!.mint({
                ...replacement, sessionId: 'protected-session', purpose: 'session', expiresAt: Date.now() + 60_000,
            }, Date.now());
            const turnPermit = (token: string, id = 'protected-session') => app.inject({
                method: 'POST', url: `/v1/sessions/${id}/work-machine-permit`,
                headers: { authorization: `Bearer ${token}` },
            });
            expect((await turnPermit(sessionToken)).statusCode).toBe(403);
            expect((await turnPermit(newSessionBearer, 'absent-session')).statusCode).toBe(403);
            expect((await turnPermit(bearer)).statusCode).toBe(403);
            expect((await turnPermit(newSessionBearer)).statusCode).toBe(204);
            expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe(false);

            const sourceId = 'ordinary-machine';
            const signingKey = generateKeyPairSync('ed25519');
            const publicDer = signingKey.publicKey.export({ format: 'der', type: 'spki' });
            const deviceId = createHash('sha256').update(publicDer).digest('base64url');
            const sessionId = 'source-session';
            await db.machine.update({
                where: { id: sourceId }, data: { dataEncryptionKey: new Uint8Array(105) },
            });
            await db.session.create({
                data: {
                    id: sessionId, tag: sessionId, accountId, metadata: 'encrypted',
                    dataEncryptionKey: new Uint8Array(105), active: true,
                },
            });
            await db.sessionOwnershipBinding.create({
                data: {
                    sessionId, sessionRowId: sessionId, bindingId: 'trusted-origin',
                    subjectIssuer: 'studio', ownerUserId: accountId, sessionAccountId: accountId,
                    machineId: sourceId, machineAccountId: accountId, intentId: 'intent-enroll',
                    operationId: 'op-enroll', nonce: 'nonce-enroll', createDigest: 'creation',
                    proofDigest: 'proof', issuedAt: new Date(),
                },
            });
            const enroll = (sessionIds: string[], signed = true, tamperedDevice = false, deviceSessionIds = sessionIds) => {
                const now = Date.now();
                const proof = {
                    publicKey: publicDer.toString('base64url'), issuedAt: now,
                    signature: sign(null, Buffer.from(JSON.stringify([
                        'happy-work-machine-enrollment-v2', tamperedDevice ? machineId : sourceId, deviceId, now, [...deviceSessionIds].sort(),
                    ])), signingKey.privateKey).toString('base64url'),
                };
                const payload = { deviceId, ownerUserId: accountId, sessionIds, proof };
                const bytes = Buffer.from(JSON.stringify({
                    kid, aud: audience, purpose: 'happy-managed-control', op: 'work-machine-enroll',
                    bodyDigest: canonicalDigest({ accountTokenDigest, machineId: sourceId, ...payload }),
                    iat: now, exp: now + 5000,
                }));
                return app.inject({
                    method: 'POST', url: `/v1/work-machines/${sourceId}/execution-enrollment`, payload,
                    headers: {
                        authorization: `Bearer ${bearer}`,
                        ...(signed ? {
                            'x-happy-control-assertion': `${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`,
                        } : {}),
                    },
                });
            };
            expect((await enroll([sessionId], false)).statusCode).toBe(403);
            expect((await enroll([sessionId], true, true)).statusCode).toBe(403);
            expect((await enroll([], true, false, [sessionId])).statusCode).toBe(403);
            expect((await enroll(['protected-session'])).statusCode).toBe(409);
            expect((await enroll([sessionId])).statusCode).toBe(409);
            expect(await db.workMachineExecution.findUnique({ where: { machineId: sourceId } })).toBeNull();
            await db.session.update({ where: { id: sessionId }, data: { active: false } });
            expect((await enroll([])).statusCode).toBe(409);
            await db.sessionOwnershipBinding.update({ where: { sessionId }, data: { confirmedAt: new Date() } });
            await db.session.update({ where: { id: sessionId }, data: { active: true } });
            expect((await enroll([sessionId])).statusCode).toBe(409);
            await db.session.update({ where: { id: sessionId }, data: { active: false } });

            const executionOnly = 'unlisted-execution';
            await db.session.create({ data: { id: executionOnly, tag: executionOnly, accountId, metadata: 'test' } });
            await db.sessionExecutionBinding.create({ data: {
                sessionId: executionOnly, sessionRowId: executionOnly, sessionRowOwnerAccountId: accountId,
                companyId: 'test-company', machineId: sourceId, machineOwnerAccountId: accountId,
                machineRowId: sourceId, machineRowOwnerAccountId: accountId, sessionOwnerAccountId: accountId,
                launchId: 'unlisted-launch', initialNonce: 'unlisted-nonce', operationId: 'unlisted-operation',
                approvalId: 'unlisted-approval', deviceKeyId: deviceId, sessionTagHash: 'test-tag',
                sessionCreateBodyHash: 'test-body', ticketDigest: 'test-ticket', createProofDigest: 'test-proof',
            } });
            expect((await enroll([sessionId])).statusCode).toBe(409);
            await db.session.delete({ where: { id: executionOnly } });

            const otherAccountId = 'another-session-owner';
            const otherSessionId = 'another-account-session';
            await db.account.create({ data: { id: otherAccountId, publicKey: otherAccountId } });
            await db.session.create({ data: { id: otherSessionId, accountId: otherAccountId, tag: 'another', metadata: 'encrypted' } });
            await db.sessionOwnershipBinding.create({
                data: {
                    sessionId: otherSessionId, sessionRowId: otherSessionId, bindingId: 'other-origin',
                    subjectIssuer: 'studio', ownerUserId: otherAccountId, sessionAccountId: otherAccountId,
                    machineId: sourceId, machineAccountId: accountId, intentId: 'intent-other',
                    operationId: 'op-other', nonce: 'nonce-other', createDigest: 'creation',
                    proofDigest: 'proof', issuedAt: new Date(), confirmedAt: new Date(),
                },
            });
            expect((await enroll([sessionId])).statusCode).toBe(409);
            await db.session.delete({ where: { id: otherSessionId } });

            const enrolled = await enroll([sessionId]);
            expect(enrolled.statusCode).toBe(200);
            expect(enrolled.json()).toMatchObject({ machineId: sourceId, generation: 1, deviceId });
            expect(await db.session.findUnique({ where: { id: sessionId }, select: { workMachineId: true } }))
                .toEqual({ workMachineId: sourceId });
            expect((await enroll([sessionId])).statusCode).toBe(200);

            function renewal(sessionId: string | null, issuedAt = Date.now()) {
                const nonce = crypto.randomUUID();
                const proofScope = [accountId, sourceId, deviceId, 1, sessionId, issuedAt, nonce];
                return {
                    accountId, deviceId, generation: 1, ...(sessionId ? { sessionId } : {}),
                    issuedAt, nonce, publicKey: publicDer.toString('base64url'),
                    signature: sign(null, Buffer.from(JSON.stringify(['happy-work-machine-renew-v1', ...proofScope])), signingKey.privateKey).toString('base64url'),
                };
            }
            const renew = (payload: object) => app.inject({
                method: 'POST', url: `/v1/work-machines/${sourceId}/execution-renewal`, payload,
            });
            const daemonProof = renewal(null);
            const concurrent = await Promise.all([renew(daemonProof), renew(daemonProof)]);
            expect(concurrent.map(result => result.statusCode).sort()).toEqual([200, 403]);
            const renewedDaemon = concurrent.find(result => result.statusCode === 200)!;
            expect(await auth.workMachineExecutionIssuer!.verify(renewedDaemon.json().token, 'daemon', Date.now()))
                .toMatchObject({ machineId: sourceId, accountId, deviceId, generation: 1 });
            expect((await renew(renewal(null, Date.now() - 60_001))).statusCode).toBe(403);
            expect((await renew({ ...renewal(sessionId), sessionId: 'protected-session' })).statusCode).toBe(403);
            expect((await renew(renewal('protected-session'))).statusCode).toBe(403);
            const renewedSession = await renew(renewal(sessionId));
            expect(renewedSession.statusCode).toBe(200);
            expect(await auth.workMachineExecutionIssuer!.verify(renewedSession.json().token, 'session', Date.now()))
                .toMatchObject({ machineId: sourceId, accountId, deviceId, generation: 1, sessionId });
            const lookup = (ids: string[], token = renewedSession.json().token) => app.inject({
                method: 'POST', url: '/v2/sessions/lookup', payload: { ids },
                headers: { authorization: `Bearer ${token}` },
            });
            const snapshot = await lookup([sessionId]);
            expect(snapshot.statusCode).toBe(200);
            expect(snapshot.json()).toMatchObject({ sessions: [{ id: sessionId, metadata: 'encrypted' }] });
            expect((await lookup(['protected-session'])).statusCode).toBe(403);
            expect((await lookup([sessionId, 'protected-session'])).statusCode).toBe(403);
            expect((await lookup([sessionId], renewedDaemon.json().token)).statusCode).toBe(401);
            const source = { machineId: sourceId, accountId, deviceId, generation: 1 };
            expect(await freezeWorkMachineExecution(db, source)).toBe(true);
            expect((await renew(renewal(null))).statusCode).toBe(403);
            expect((await lookup([sessionId])).statusCode).toBe(403);
            expect(await replaceWorkMachineExecution(db, source, replacement.deviceId)).toBe(true);
            expect((await renew(renewal(sessionId))).statusCode).toBe(403);
        } finally {
            await app.close();
            vi.unstubAllEnvs();
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });
});
