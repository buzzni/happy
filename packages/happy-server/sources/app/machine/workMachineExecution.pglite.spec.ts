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
import { automationExecutionRoutes } from '@/app/api/routes/automationExecutionRoutes';
import { v3SessionEventRoutes } from '@/app/api/routes/v3SessionEventRoutes';
import { pushRoutes } from '@/app/api/routes/pushRoutes';
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
import { createWorkMachineExecutionTokenIssuer, type WorkMachineExecutionClaims } from '@/app/auth/workMachineExecutionToken';
import * as machineSockets from '@/app/events/findMachineSockets';
import { eventRouter } from '@/app/events/eventRouter';
import { SCRIPT_CLAIM_LEASE_MS } from '@/app/automation/scriptInvocationService';
import { SESSION_FOLLOWUP_CLAIM_MS } from '@/app/automation/sessionFollowupExecutionService';
import { automationExecutionSessionId, SCRIPT_AUTOMATION_PROTOCOL_VERSION, SESSION_FOLLOWUP_WIRE_VERSION } from '@slopus/happy-wire';
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
        data: { deviceId: original.deviceId, generation: original.generation, previousDeviceId: null, frozenAt: null, firstExecutionAt: null },
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
            // Status the web client polls after a switch must not close the way back.
            for (const method of ['daemon-session-state', 'mcp-status', 'getDirectoryTree', 'ripgrep', 'get-port',
                'claude-list-rewind-points', 'codex-list-rewind-points', 'checkpoint:list', 'checkpoint:status', 'checkpoint:diff']) {
                expect((await invoke(method)).refused, method).toBe(false);
            }
            expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt).toBeNull();
            expect((await invoke('writeFile')).refused).toBe(true);
            await freezeWorkMachineExecution(db, original);
            expect((await invoke('readFile')).refused).toBe(true);
            expect(emitted).toHaveLength(11);
        } finally {
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
        }
    });

    // dev E2E 2nd round, defect 5: what reaches a freshly started daemon and its conversations before
    // anyone sends a message must not close the way back, yet still stops at drain and freeze.
    it('lets housekeeping RPCs reach a freshly started daemon and its conversations without recording first execution', async () => {
        const now = Date.now();
        const emitted: string[] = [];
        const emit = { timeout: () => ({ emitWithAck: async (_event: string, request: { method: string }) => { emitted.push(request.method); return {}; } }) };
        const daemon = { data: { workMachineExecution: { ...original, purpose: 'daemon', expiresAt: now + 60_000 } }, ...emit };
        const conversation = { data: { workMachineExecution: { ...original, sessionId: 'protected-session', purpose: 'session', expiresAt: now + 60_000 } }, ...emit };
        const invoke = async (scope: string, method: string) => (await executeDaemonRpcLocally({
            io: { sockets: { sockets: new Map<string, unknown>([['daemon', daemon], ['conversation', conversation]]) } } as never,
            request: { requestId: crypto.randomUUID(), targetSocketId: scope === machineId ? 'daemon' : 'conversation',
                method: `${scope}:${method}`, params: {}, timeoutMs: 1000 },
            onResult: () => {}, deps: { allowed: (async () => true) as never, now: () => now },
        })).refused;
        const firstExecution = async () => (await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt;
        const workspaceReads = ['listWorkspaceDirectory', 'readWorkspaceFile', 'readWorkspaceFileChunk',
            'listWorkspaceDownloadDirectory', 'closeWorkspaceDownloadDirectory'];

        // Opening a conversation again, an idle stop and workspace reads run no turn.
        for (const method of ['resume-happy-session', 'stop-session', ...workspaceReads]) {
            expect(await invoke(machineId, method), method).toBe(false);
        }
        expect(await invoke('protected-session', 'killSession')).toBe(false);
        expect(await firstExecution()).toBeNull();
        // A shell command may change anything; the server cannot tell a status poll from any other one.
        expect(await invoke(machineId, 'bash')).toBe(false);
        expect(await firstExecution()).not.toBeNull();

        await db.workMachineExecution.update({ where: { machineId }, data: { firstExecutionAt: null, drainingAt: new Date() } });
        try {
            // Draining stops new work, including bringing a conversation back up; stopping and reading go on.
            expect(await invoke(machineId, 'resume-happy-session')).toBe(true);
            for (const method of ['stop-session', ...workspaceReads]) expect(await invoke(machineId, method), method).toBe(false);
            expect(await invoke('protected-session', 'killSession')).toBe(false);
            expect(await firstExecution()).toBeNull();
            await freezeWorkMachineExecution(db, original);
            for (const method of ['resume-happy-session', 'stop-session', 'listWorkspaceDirectory']) {
                expect(await invoke(machineId, method), method).toBe(true);
            }
            expect(await invoke('protected-session', 'killSession')).toBe(true);
        } finally {
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
        }
    });

    it('lets a draining conversation answer and abort its turn but refuses new turn work', async () => {
        const now = Date.now();
        const emitted: string[] = [];
        const socket = { data: { workMachineExecution: { ...original, sessionId: 'protected-session', purpose: 'session', expiresAt: now + 60_000 } },
            timeout: () => ({ emitWithAck: async (_event: string, request: { method: string }) => { emitted.push(request.method); return {}; } }) };
        const invoke = async (method: string) => (await executeDaemonRpcLocally({
            io: { sockets: { sockets: new Map([['socket', socket]]) } } as never,
            request: { requestId: crypto.randomUUID(), targetSocketId: 'socket', method: `protected-session:${method}`, params: {}, timeoutMs: 1000 },
            onResult: () => {}, deps: { allowed: (async () => true) as never, now: () => now },
        })).refused;
        const firstExecution = async () => (await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt;
        await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
        try {
            // Stopping a turn runs nothing new.
            expect(await invoke('abort')).toBe(false);
            expect(await firstExecution()).toBeNull();
            expect(await invoke('steer')).toBe(true);
            expect(await invoke('constructor')).toBe(true);
            expect(await firstExecution()).toBeNull();
            // Approving a tool lets it run, so an answer counts as execution.
            expect(await invoke('permission')).toBe(false);
            expect(await firstExecution()).not.toBeNull();
            expect(await invoke('permission')).toBe(false);
            await freezeWorkMachineExecution(db, original);
            expect(await invoke('abort')).toBe(true);
            expect(await invoke('permission')).toBe(true);
            expect(emitted).toEqual(['protected-session:abort', 'protected-session:permission', 'protected-session:permission']);
        } finally {
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
        }
    });

    it('blocks handoff until admitted connector work has a confirmed outcome', async () => {
        const requestId = crypto.randomUUID();
        const secondId = crypto.randomUUID();
        await expect(authority.admitWorkMachineMcpCall(db, original, requestId)).resolves.toBe(true);
        // A retry after a lost answer is the same admission; another scope cannot take the request id.
        await expect(authority.admitWorkMachineMcpCall(db, original, requestId)).resolves.toBe(true);
        await expect(authority.admitWorkMachineMcpCall(db, { ...original, deviceId: 'other-pc' }, requestId)).resolves.toBe(false);
        expect(await db.workMachineMcpCall.count({ where: { requestId } })).toBe(1);
        expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt).not.toBeNull();
        expect(await freezeWorkMachineExecution(db, original)).toBe(true);
        await expect(authority.admitWorkMachineMcpCall(db, original, secondId)).resolves.toBe(false);
        await expect(replaceWorkMachineExecution(db, original, replacement.deviceId)).resolves.toBe('open-mcp-calls');
        await authority.finishWorkMachineMcpCall(db, { ...original, generation: 2 }, requestId);
        await expect(replaceWorkMachineExecution(db, original, replacement.deviceId)).resolves.toBe('open-mcp-calls');
        await authority.finishWorkMachineMcpCall(db, original, requestId);
        await authority.finishWorkMachineMcpCall(db, original, requestId);
        await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: null } });
        // A finished call is not admitted again.
        await expect(authority.admitWorkMachineMcpCall(db, original, requestId)).resolves.toBe(false);
        await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
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
        expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe('first-execution-recorded');
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
        await expect(replaceWorkMachineExecution(db, original, 'late-device')).resolves.toBe('generation-mismatch');
        await expect(authorizeWorkMachineExecution(db, original)).resolves.toBe(false);
        await expect(authorizeWorkMachineExecution(db, { ...replacement, deviceId: original.deviceId })).resolves.toBe(false);
        await expect(authorizeWorkMachineExecution(db, replacement)).resolves.toBe(true);
        await expect(machineSocketIdentityExists(db, accountId, machineId)).resolves.toBe(false);
    });

    it('makes the replacement first execution permit and rollback mutually exclusive', async () => {
        await db.workMachineExecution.update({
            where: { machineId },
            data: {
                deviceId: replacement.deviceId, generation: replacement.generation, previousDeviceId: original.deviceId,
                frozenAt: null, firstExecutionAt: null,
            },
        });
        const [allowed, restored] = await Promise.all([
            permitWorkMachineExecution(db, replacement, new Date('2026-11-22T00:00:00Z')),
            restoreWorkMachineExecution(db, replacement, original.deviceId),
        ]);

        expect(Number(allowed) + Number(restored === true)).toBe(1);
        expect(restored === true || restored === 'first-execution-recorded').toBe(true);
        const current = await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } });
        expect(current.deviceId).toBe(allowed ? replacement.deviceId : original.deviceId);
        expect(current.generation).toBe(allowed ? replacement.generation : replacement.generation + 1);
        expect(current.firstExecutionAt !== null).toBe(allowed);
        await expect(permitWorkMachineExecution(db, original, new Date())).resolves.toBe(false);
    });

    it('restores only to the device the replace moved the authority away from', async () => {
        const row = () => db.workMachineExecution.findUniqueOrThrow({ where: { machineId } });
        // An enrolled generation was never handed off, so it has nowhere to return to.
        expect(await restoreWorkMachineExecution(db, original, 'enrolled-elsewhere')).toBe('previous-device-mismatch');
        expect(await freezeWorkMachineExecution(db, original)).toBe(true);
        expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
        expect(await row()).toMatchObject({ previousDeviceId: original.deviceId });
        expect(await restoreWorkMachineExecution(db, replacement, 'some-other-pc')).toBe('previous-device-mismatch');
        expect(await row()).toMatchObject({ deviceId: replacement.deviceId, generation: replacement.generation });
        expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe(true);
        expect(await row()).toMatchObject({ deviceId: original.deviceId, generation: replacement.generation + 1, previousDeviceId: null });
        // A restore does not chain back to the replacement.
        expect(await restoreWorkMachineExecution(db, { ...original, generation: replacement.generation + 1 }, replacement.deviceId))
            .toBe('previous-device-mismatch');
    });

    it('refuses to restore while the replacement holds an unfinished automation claim', async () => {
        const project = await db.project.create({ data: { accountId, name: 'restore-open-claim' } });
        const automation = await db.automation.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId,
            payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer', viewerKeyVersion: 1,
            viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
        } });
        try {
            expect(await freezeWorkMachineExecution(db, original)).toBe(true);
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            const claimedAt = new Date();
            const run = await db.automationRun.create({ data: {
                automationId: automation.id, generation: 1, scheduledFor: claimedAt, machineAccountId: accountId, machineId,
                status: 'CLAIMED', claimTokenHash: new Uint8Array(32).fill(7), claimExpiresAt: new Date(Date.now() + 60_000), claimedAt,
            } });
            expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe('open-automation-runs');
            expect(await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } }))
                .toMatchObject({ deviceId: replacement.deviceId, generation: replacement.generation });
            await db.automationRun.update({ where: { id: run.id }, data: { status: 'EXPIRED', completedAt: new Date() } });
            expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe(true);
        } finally {
            await db.project.delete({ where: { id: project.id } });
        }
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

    it('lists the unfinished automation claims of this machine and refuses replace until each one ends', async () => {
        const project = await db.project.create({ data: { accountId, name: 'open-claims' } });
        const keys = {
            payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer', viewerKeyVersion: 1,
            viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
        };
        const automation = await db.automation.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, payloadVersion: 3, ...keys,
        } });
        await db.scriptArtifact.create({ data: { id: 'open-claims-artifact', projectId: project.id, digest: 'digest', encrypted: {} } });
        await db.scriptAutomationRevision.create({ data: {
            automationId: automation.id, revision: 1, artifactId: 'open-claims-artifact', digest: 'digest',
            payloadCiphertext: 'encrypted', admission: {}, ready: true,
        } });
        const now = Date.now();
        const at = (offset: number) => new Date(now + offset);
        const run = (id: string, data: object = {}) => db.automationRun.create({ data: {
            id, automationId: automation.id, generation: 1, scheduledFor: at(0), machineAccountId: accountId, machineId,
            status: 'CLAIMED', claimTokenHash: createHash('sha256').update(id).digest(), claimExpiresAt: at(60_000),
            claimedAt: at(-3_000), ...data,
        } });
        await run('claimed-run');
        await run('running-run', { status: 'RUNNING', claimedAt: at(-5_000), claimExpiresAt: at(-1_000), runLeaseExpiresAt: at(60_000) });
        await run('lapsed-run', { status: 'RUNNING', runLeaseExpiresAt: at(-1) });
        await run('expired-claim', { claimExpiresAt: at(-1) });
        await run('finished-run', { status: 'COMPLETED' });
        await run('other-machine-run', { machineId: 'ordinary-machine' });
        const script = (id: string, data: object = {}, target = machineId) => db.scriptInvocation.create({ data: {
            id, automationId: automation.id, revision: 1, generation: 1, trigger: 'MANUAL', requestedBy: accountId,
            idempotencyKey: id, bodyHash: 'hash', snapshot: { machineId: target, machineAccountId: accountId },
            inputCiphertext: 'encrypted', createdAt: now - 90_000, ...data,
        } });
        await script('claimed-script', { status: 'CLAIMED', claimHash: 'claimed', leaseExpiresAt: now + 100_000 });
        await script('running-script', { status: 'RUNNING', claimHash: 'running', startedAt: now - 4_000, leaseExpiresAt: now + 60_000 });
        await script('lapsed-script', { status: 'RUNNING', claimHash: 'lapsed', startedAt: now - 400_000, leaseExpiresAt: now - 1 });
        await script('queued-script');
        await script('other-machine-script', { status: 'CLAIMED', claimHash: 'other', leaseExpiresAt: now + 60_000 }, 'ordinary-machine');
        const followup = (id: string, data: object = {}) => db.sessionFollowup.create({ data: {
            id, projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, sessionId: `${id}-session`,
            ...keys, totalRounds: 3, currentRound: 1, responseBoundarySeq: 0, lastObservedSeq: 0, ...data,
        } });
        const claim = (id: string, expiresIn: number) => ({
            claimTokenHash: createHash('sha256').update(id).digest(), claimExpiresAt: at(expiresIn), claimedGeneration: 1, claimedStep: 1,
        });
        await followup('claimed-followup', claim('claimed-followup', 30_000));
        await followup('unclaimed-followup');
        await followup('expired-followup', claim('expired-followup', -1));
        await followup('other-machine-followup', { ...claim('other-machine-followup', 30_000), machineId: 'ordinary-machine' });
        try {
            expect(await authority.listOpenWorkMachineAutomationRuns(db, { accountId, machineId }, at(0))).toEqual([
                { kind: 'session-followup', id: 'claimed-followup', claimedAt: at(30_000 - SESSION_FOLLOWUP_CLAIM_MS) },
                { kind: 'script-invocation', id: 'claimed-script', claimedAt: at(100_000 - SCRIPT_CLAIM_LEASE_MS) },
                { kind: 'automation-run', id: 'running-run', claimedAt: at(-5_000) },
                { kind: 'script-invocation', id: 'running-script', claimedAt: at(-4_000) },
                { kind: 'automation-run', id: 'claimed-run', claimedAt: at(-3_000) },
            ]);
            expect(await authority.listOpenWorkMachineAutomationRuns(db, { accountId, machineId: 'ordinary-machine' }, at(0)))
                .toHaveLength(3);

            expect(await freezeWorkMachineExecution(db, original)).toBe(true);
            const finishes = [
                () => db.sessionFollowup.update({ where: { id: 'claimed-followup' }, data: { claimTokenHash: null, claimExpiresAt: null } }),
                () => db.scriptInvocation.update({ where: { id: 'claimed-script' }, data: { status: 'CANCELLED', completedAt: now } }),
                () => db.automationRun.update({ where: { id: 'running-run' }, data: { status: 'COMPLETED', completedAt: at(0) } }),
                () => db.scriptInvocation.update({ where: { id: 'running-script' }, data: { status: 'COMPLETED', completedAt: now } }),
                () => db.automationRun.update({ where: { id: 'claimed-run' }, data: { status: 'EXPIRED', completedAt: at(0) } }),
            ];
            for (const finish of finishes) {
                expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe('open-automation-runs');
                expect(await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } }))
                    .toMatchObject({ deviceId: original.deviceId, generation: 1 });
                await finish();
            }
            expect(await authority.listOpenWorkMachineAutomationRuns(db, { accountId, machineId }, new Date())).toEqual([]);
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);

            await db.automationRun.createMany({ data: Array.from({ length: 51 }, (_, index) => ({
                id: `many-${index}`, automationId: automation.id, generation: 1, scheduledFor: at(0), machineAccountId: accountId,
                machineId, status: 'CLAIMED' as const, claimTokenHash: createHash('sha256').update(`many-${index}`).digest(),
                claimExpiresAt: at(60_000), claimedAt: at(index - 100),
            })) });
            const many = await authority.listOpenWorkMachineAutomationRuns(db, { accountId, machineId }, at(0));
            expect(many).toHaveLength(50);
            expect(many[0].id).toBe('many-0');
            expect(many[49].id).toBe('many-49');
        } finally {
            await db.project.delete({ where: { id: project.id } });
        }
    });

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
                mode: 'device', deviceId: source.id, generation: 1, frozen: false, draining: false, firstExecution: false,
                openMcpCalls: [], openAutomationRuns: [],
            });
            const unsigned = await app.inject({
                method: 'POST', url: `/v1/work-machines/${migrating}/execution-drain`, payload: at(1),
                headers: { authorization: `Bearer ${bearer}` },
            });
            expect(unsigned.statusCode).toBe(403);
            expect((await control('drain', at(1), 'work-machine-freeze')).statusCode).toBe(403);
            const notDrained = await control('freeze', at(1));
            expect(notDrained.statusCode).toBe(409);
            expect(notDrained.json()).toMatchObject({ reason: 'not-draining' });
            const otherGeneration = await control('drain', at(2));
            expect(otherGeneration.statusCode).toBe(409);
            expect(otherGeneration.json()).toMatchObject({ reason: 'generation-mismatch' });

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
            const notFrozen = await control('mcp-reconcile', { ...at(1), requestId });
            expect(notFrozen.statusCode).toBe(409);
            expect(notFrozen.json()).toMatchObject({ reason: 'not-frozen' });
            expect((await control('freeze', at(1))).json()).toEqual(frozen);
            expect(await write(sourceToken, 'after-freeze')).toBe(403);

            const nextKey = envelope(2);
            const openCall = await control('replace', replaceBody(1, nextKey));
            expect(openCall.statusCode).toBe(409);
            expect(openCall.json()).toMatchObject({ reason: 'open-mcp-calls' });
            expect((await db.machine.findUniqueOrThrow({ where: { id: migrating } })).dataEncryptionKey).toEqual(new Uint8Array(envelope(1)));
            const reconciled = await control('mcp-reconcile', { ...at(1), requestId });
            expect(reconciled.statusCode).toBe(200);
            expect(reconciled.json()).toEqual({ requestId, reconciledAt: expect.any(Number) });
            expect((await control('mcp-reconcile', { ...at(1), requestId })).json()).toEqual(reconciled.json());
            expect((await control('mcp-reconcile', { ...at(1), requestId: crypto.randomUUID() })).statusCode).toBe(404);
            expect((await state()).openMcpCalls).toEqual([]);

            // A scheduled run the old generation claimed before the drain also holds the handoff.
            const project = await db.project.create({ data: { accountId, name: 'migrating-automation' } });
            const automation = await db.automation.create({ data: {
                projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId: migrating,
                payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer', viewerKeyVersion: 1,
                viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
            } });
            const claimedAt = new Date(Date.now() - 1_000);
            const openRun = await db.automationRun.create({ data: {
                automationId: automation.id, generation: 1, scheduledFor: claimedAt, machineAccountId: accountId, machineId: migrating,
                status: 'RUNNING', claimTokenHash: new Uint8Array(32).fill(9), claimExpiresAt: claimedAt, claimedAt,
                startedAt: claimedAt, runLeaseExpiresAt: new Date(Date.now() + 300_000),
            } });
            expect((await state()).openAutomationRuns)
                .toEqual([{ kind: 'automation-run', id: openRun.id, claimedAt: claimedAt.getTime() }]);
            const openClaim = await control('replace', replaceBody(1, nextKey));
            expect(openClaim.statusCode).toBe(409);
            expect(openClaim.json()).toMatchObject({ reason: 'open-automation-runs' });
            expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId: migrating } })).deviceId).toBe(source.id);
            await db.automationRun.update({ where: { id: openRun.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
            expect((await state()).openAutomationRuns).toEqual([]);

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
            const otherKey = await control('replace', replaceBody(1, envelope(4)));
            expect(otherKey.statusCode).toBe(409);
            expect(otherKey.json()).toMatchObject({ reason: 'key-mismatch' });
            const after = await db.machine.findUniqueOrThrow({ where: { id: migrating } });
            expect(after.dataEncryptionKey).toEqual(new Uint8Array(nextKey));
            expect(after.metadataVersion).toBe(before.metadataVersion + 1);
            expect(after.daemonStateVersion).toBe(before.daemonStateVersion + 1);
            expect(await state()).toEqual({
                mode: 'device', deviceId: target.id, generation: 2, frozen: false, draining: false, firstExecution: false,
                openMcpCalls: [], openAutomationRuns: [],
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
            const ranAlready = await control('restore', restoreBody(4, envelope(7)));
            expect(ranAlready.statusCode).toBe(409);
            expect(ranAlready.json()).toMatchObject({ reason: 'first-execution-recorded' });
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
                    frozen: false, draining: false, firstExecution: false, openMcpCalls: [], openAutomationRuns: [],
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
            const readDaemonScope = (executionToken: string, { asserted = executionToken, target = machineId,
                op = 'work-machine-daemon-execution-scope' } = {}) => app.inject({
                method: 'POST', url: `/v1/work-machines/${target}/daemon-execution-scope`, payload: { executionToken },
                headers: {
                    authorization: `Bearer ${bearer}`,
                    'x-happy-control-assertion': proof({ executionToken: asserted }, op, target),
                },
            });
            const mintDaemon = (claims: typeof original) => issuer.mint({ ...claims, purpose: 'daemon', expiresAt }, Date.now());
            const daemonScope = await readDaemonScope(daemonToken);
            expect(daemonScope.statusCode).toBe(200);
            expect(daemonScope.json()).toEqual(original);
            expect((await readDaemonScope(sessionToken)).statusCode).toBe(403);
            expect((await readDaemonScope(daemonToken, { asserted: sessionToken })).statusCode).toBe(403);
            expect((await readDaemonScope(daemonToken, { op: 'work-machine-mcp-execution-scope' })).statusCode).toBe(403);
            expect((await readDaemonScope(daemonToken, { target: 'ordinary-machine' })).statusCode).toBe(403);
            expect((await readDaemonScope(await mintDaemon({ ...original, deviceId: 'other-pc' }))).statusCode).toBe(403);
            expect((await readDaemonScope(await mintDaemon({ ...original, generation: 2 }))).statusCode).toBe(403);
            // Another account's current daemon credential, presented with this account's bearer.
            const foreign = { accountId: 'foreign-account', machineId: 'foreign-machine', deviceId: 'foreign-pc', generation: 1 };
            await db.account.create({ data: { id: foreign.accountId, publicKey: foreign.accountId } });
            await db.machine.create({ data: { id: foreign.machineId, accountId: foreign.accountId, metadata: 'encrypted' } });
            await db.workMachineExecution.create({ data: foreign });
            expect((await readDaemonScope(await mintDaemon(foreign), { target: foreign.machineId })).statusCode).toBe(403);
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
            try {
                expect((await readDaemonScope(daemonToken)).json()).toEqual(original);
            } finally {
                await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
            }
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
            expect((await readDaemonScope(daemonToken)).statusCode).toBe(403);
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe('open-mcp-calls');
            expect((await signedCall('finish', proof(call, 'work-machine-mcp-admit'))).statusCode).toBe(403);
            expect((await signedCall('finish', proof(call, 'work-machine-mcp-finish'))).statusCode).toBe(204);
            expect(await db.workMachineMcpCall.count({ where: { requestId: call.requestId, completedAt: { not: null } } })).toBe(1);
            expect((await state(machineId, stateProof(machineId))).json())
                .toEqual({
                    mode: 'device', deviceId: original.deviceId, generation: 1,
                    frozen: true, draining: false, firstExecution: true, openMcpCalls: [], openAutomationRuns: [],
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
            expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe('first-execution-recorded');

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

    it('enrolls a PC whose existing unbound conversations Studio attributes to it and names what it refuses', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const control = generateKeyPairSync('ed25519');
        const kid = 'attribution-key';
        const audience = 'attribution-happy';
        const verifier = createControlAssertionVerifier({
            audience,
            verifierKeys: JSON.stringify({ [kid]: control.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') }),
        });
        const owner = 'attribution-owner';
        const pc = 'attribution-pc';
        const otherAccount = 'attribution-stranger';
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            workMachineExecutionRoutes(app as unknown as Fastify, () => verifier);
            await db.account.createMany({ data: [{ id: owner, publicKey: owner }, { id: otherAccount, publicKey: otherAccount }] });
            await db.machine.create({ data: { id: pc, accountId: owner, metadata: 'encrypted', dataEncryptionKey: new Uint8Array(105) } });
            const conversation = (id: string, accountId = owner) => db.session.create({
                data: { id, tag: id, accountId, metadata: 'encrypted', dataEncryptionKey: new Uint8Array(105), active: false },
            });
            await conversation('unbound-a');
            await conversation('unbound-b');
            const bearer = await auth.createToken(owner);
            const accountTokenDigest = createHash('sha256').update(bearer).digest('hex');
            const signingKey = generateKeyPairSync('ed25519');
            const publicDer = signingKey.publicKey.export({ format: 'der', type: 'spki' });
            const deviceId = createHash('sha256').update(publicDer).digest('base64url');
            const enroll = (sessionIds: string[], studioAttributedSessionIds: string[], signedAttribution = studioAttributedSessionIds) => {
                const now = Date.now();
                const proof = {
                    publicKey: publicDer.toString('base64url'), issuedAt: now,
                    signature: sign(null, Buffer.from(JSON.stringify([
                        'happy-work-machine-enrollment-v2', pc, deviceId, now, [...sessionIds].sort(),
                    ])), signingKey.privateKey).toString('base64url'),
                };
                const payload = { deviceId, ownerUserId: 'studio-user', sessionIds, studioAttributedSessionIds, proof };
                const bytes = Buffer.from(JSON.stringify({
                    kid, aud: audience, purpose: 'happy-managed-control', op: 'work-machine-enroll',
                    bodyDigest: canonicalDigest({
                        accountTokenDigest, machineId: pc, ...payload, studioAttributedSessionIds: signedAttribution,
                    }),
                    iat: now, exp: now + 5000,
                }));
                return app.inject({
                    method: 'POST', url: `/v1/work-machines/${pc}/execution-enrollment`, payload,
                    headers: {
                        authorization: `Bearer ${bearer}`,
                        'x-happy-control-assertion': `${bytes.toString('base64url')}.${sign(null, bytes, control.privateKey).toString('base64url')}`,
                    },
                });
            };
            const refusal = async (response: Promise<{ statusCode: number; json(): unknown }>) => {
                const reply = await response;
                return { status: reply.statusCode, body: reply.json() };
            };

            // Only Studio's assertion vouches for a conversation without an ownership binding.
            expect(await refusal(enroll(['unbound-a', 'unbound-b'], ['unbound-a']))).toEqual({
                status: 409, body: { error: 'Work machine enrollment not ready', reason: 'unattributed-sessions', sessionIds: ['unbound-b'] },
            });
            // The attribution is part of the signed body: a caller cannot widen it.
            expect((await enroll(['unbound-a', 'unbound-b'], ['unbound-a', 'unbound-b'], ['unbound-a'])).statusCode).toBe(403);

            await db.session.update({ where: { id: 'unbound-b' }, data: { active: true } });
            expect(await refusal(enroll(['unbound-a', 'unbound-b'], ['unbound-a', 'unbound-b']))).toMatchObject({
                status: 409, body: { reason: 'active-session', sessionIds: ['unbound-b'] },
            });
            await db.session.update({ where: { id: 'unbound-b' }, data: { active: false } });

            await conversation('stranger-session', otherAccount);
            expect(await refusal(enroll(['unbound-a', 'stranger-session'], ['unbound-a', 'stranger-session']))).toMatchObject({
                status: 409, body: { reason: 'unknown-sessions', sessionIds: ['stranger-session'] },
            });

            // A conversation bound to another machine keeps the binding checks even when attributed.
            await conversation('bound-elsewhere');
            await db.sessionOwnershipBinding.create({ data: {
                sessionId: 'bound-elsewhere', sessionRowId: 'bound-elsewhere', bindingId: 'attribution-elsewhere',
                subjectIssuer: 'studio', ownerUserId: 'studio-user', sessionAccountId: owner,
                machineId: 'ordinary-machine', machineAccountId: owner, intentId: 'attribution-intent',
                operationId: 'attribution-op', nonce: 'attribution-nonce', createDigest: 'creation',
                proofDigest: 'proof', issuedAt: new Date(), confirmedAt: new Date(),
            } });
            expect(await refusal(enroll(['unbound-a', 'bound-elsewhere'], ['unbound-a', 'bound-elsewhere']))).toMatchObject({
                status: 409, body: { reason: 'session-bound-elsewhere', sessionIds: ['bound-elsewhere'] },
            });

            await conversation('bound-other-owner');
            await db.sessionOwnershipBinding.create({ data: {
                sessionId: 'bound-other-owner', sessionRowId: 'bound-other-owner', bindingId: 'attribution-other-owner',
                subjectIssuer: 'studio', ownerUserId: 'another-studio-user', sessionAccountId: owner,
                machineId: pc, machineAccountId: owner, intentId: 'attribution-intent-2',
                operationId: 'attribution-op-2', nonce: 'attribution-nonce-2', createDigest: 'creation',
                proofDigest: 'proof', issuedAt: new Date(), confirmedAt: new Date(),
            } });
            expect(await refusal(enroll(['unbound-a', 'bound-other-owner'], ['unbound-a', 'bound-other-owner']))).toMatchObject({
                status: 409, body: { reason: 'owner-mismatch', sessionIds: ['bound-other-owner'] },
            });
            await db.sessionOwnershipBinding.delete({ where: { sessionId: 'bound-other-owner' } });

            await db.machine.create({ data: { id: 'attribution-held-pc', accountId: owner, metadata: 'encrypted' } });
            await db.workMachineExecution.create({ data: { machineId: 'attribution-held-pc', accountId: owner, deviceId: 'held', generation: 1 } });
            await db.session.update({ where: { id: 'unbound-b' }, data: { workMachineId: 'attribution-held-pc' } });
            expect(await refusal(enroll(['unbound-a', 'unbound-b'], ['unbound-a', 'unbound-b']))).toMatchObject({
                status: 409, body: { reason: 'session-attached', sessionIds: ['unbound-b'] },
            });
            await db.session.update({ where: { id: 'unbound-b' }, data: { workMachineId: null } });
            expect(await db.workMachineExecution.findUnique({ where: { machineId: pc } })).toBeNull();

            const enrolled = await enroll(['unbound-a', 'unbound-b'], ['unbound-a', 'unbound-b']);
            expect(enrolled.statusCode).toBe(200);
            expect(enrolled.json()).toMatchObject({ machineId: pc, accountId: owner, deviceId, generation: 1 });
            expect(await db.session.findMany({ where: { id: { in: ['unbound-a', 'unbound-b'] } }, select: { workMachineId: true } }))
                .toEqual([{ workMachineId: pc }, { workMachineId: pc }]);
            // A lost acknowledgement is answered again with the same grant.
            expect((await enroll(['unbound-a', 'unbound-b'], ['unbound-a', 'unbound-b'])).statusCode).toBe(200);
            await db.workMachineExecution.update({ where: { machineId: pc }, data: { frozenAt: new Date() } });
            expect(await refusal(enroll(['unbound-a', 'unbound-b'], ['unbound-a', 'unbound-b'])))
                .toMatchObject({ status: 409, body: { reason: 'generation-conflict' } });
        } finally {
            await app.close();
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });

    it('creates a new conversation attached to the work machine only with the current device daemon credential', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const updates = vi.spyOn(eventRouter, 'emitUpdate').mockImplementation(() => {});
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            enableSessionScopeAuthentication(app as unknown as Fastify, () => null);
            sessionRoutes(app as unknown as Fastify);
            const daemon = (device: typeof original, target = machineId) => {
                const now = Date.now();
                return auth.workMachineExecutionIssuer!.mint({ ...device, machineId: target, purpose: 'daemon', expiresAt: now + 60_000 }, now);
            };
            const create = (token: string, tag: string, extra: object = {}) => app.inject({
                method: 'POST', url: '/v1/sessions', headers: { authorization: `Bearer ${token}` },
                payload: { tag, metadata: 'encrypted-new', dataEncryptionKey: Buffer.from('key').toString('base64'), ...extra },
            });
            const current = await daemon(original);

            const created = await create(current, 'device-new-1');
            expect(created.statusCode).toBe(200);
            const row = await db.session.findUniqueOrThrow({ where: { id: created.json().session.id } });
            expect(row).toMatchObject({ accountId, tag: 'device-new-1', workMachineId: machineId, metadata: 'encrypted-new' });
            expect(updates).toHaveBeenCalledWith(expect.objectContaining({ userId: accountId, recipientFilter: { type: 'user-scoped-only' } }));
            const retried = await create(current, 'device-new-1');
            expect(retried.statusCode).toBe(200);
            expect(retried.json().session.id).toBe(row.id);

            // A tag already used by a conversation outside this work machine is not adopted.
            await db.session.create({ data: { id: 'unattached-tag', tag: 'device-unattached', accountId, metadata: 'encrypted' } });
            expect((await create(current, 'device-unattached')).statusCode).toBe(409);
            // Proof-bound creation stays on its own path; the daemon credential cannot carry one.
            expect((await create(current, 'device-proof', { ownershipProof: {} })).statusCode).toBe(403);
            // An account token cannot attach a conversation to the work machine.
            const legacy = await create(await auth.createToken(accountId), 'legacy-new');
            expect(legacy.statusCode).toBe(200);
            expect((await db.session.findUniqueOrThrow({ where: { id: legacy.json().session.id } })).workMachineId).toBeNull();
            // A machine without device authority and a device that is not current are refused.
            expect((await create(await daemon(original, 'ordinary-machine'), 'device-ordinary')).statusCode).toBe(403);
            expect((await create(await daemon({ ...original, deviceId: 'other-pc' }), 'device-other')).statusCode).toBe(403);

            // A drain is named, so the daemon can tell the user new work is paused for a migration.
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
            for (const tag of ['device-draining', 'device-new-1']) {
                const drained = await create(current, tag);
                expect(drained.statusCode).toBe(409);
                expect(drained.json()).toEqual({ error: 'Work machine is draining', reason: 'work-machine-draining' });
            }
            await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
            expect((await create(current, 'device-frozen')).statusCode).toBe(403);
            expect((await create(current, 'device-new-1')).statusCode).toBe(403);
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null, frozenAt: null } });
            await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            expect((await create(current, 'device-old-generation')).statusCode).toBe(403);
            const firstExecution = async () => (await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt;
            const replacementToken = await daemon(replacement);
            expect((await create(replacementToken, 'device-unattached')).statusCode).toBe(409);
            expect(await firstExecution()).toBeNull();
            const next = await create(replacementToken, 'device-new-generation');
            expect(next.statusCode).toBe(200);
            // A new conversation on the replacement is its work: the way back closes.
            expect(await firstExecution()).not.toBeNull();
            expect(await db.session.count({ where: { tag: { in: ['device-draining', 'device-frozen', 'device-old-generation', 'device-ordinary', 'device-other', 'device-proof'] } } })).toBe(0);
        } finally {
            updates.mockRestore();
            await app.close();
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });

    it('lets the current device run scheduled automation: claims stop at drain, claimed runs finish until the freeze', async () => {
        vi.stubEnv('SAYCODE_AUTOMATION_ENABLED', 'true');
        const project = await db.project.create({ data: { accountId, name: 'device-automation', automationViewerKeyVersion: 1 } });
        await db.machine.update({ where: { id: machineId }, data: { automationKeyVersion: 1 } });
        const automations = await Promise.all(['first', 'second', 'third'].map(name => db.automation.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, payloadVersion: 1,
            payloadCiphertext: new Uint8Array(1), viewerKeyId: `viewer-${name}`, viewerKeyVersion: 1,
            viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
            enabledAt: new Date(Date.now() - 60_000),
        } })));
        await db.session.create({ data: { id: 'unattached-report-target', tag: 'unattached-report-target', accountId, metadata: 'encrypted' } });
        const expiresAt = Date.now() + 60_000;
        const worker = (device: WorkMachineExecutionClaims | null) => {
            const handlers = new Map<string, (data: unknown, callback: (result: unknown) => void) => Promise<void>>();
            automationSocketHandler(accountId, machineId, { on: (event: string, handler: never) => handlers.set(event, handler) } as never,
                device as never);
            return (event: string, data: object) => new Promise<{ ok: boolean; value?: any; error?: string }>(resolve =>
                void handlers.get(event)!(data, resolve as never));
        };
        const current = worker({ ...original, purpose: 'daemon', expiresAt });
        const claim = (send: ReturnType<typeof worker>, automationId: string) =>
            send('automation-claim', { automationId, generation: 1, scheduledFor: Date.now() });
        const report = (send: ReturnType<typeof worker>, run: { runId: string; claimToken: string }, sessionId: string | null, reportId: string) =>
            send('automation-run-report', { ...run, reportId, status: 'COMPLETED', outcome: 'WOKE', sessionId, detailCiphertext: null });
        try {
            expect(await claim(worker(null), automations[0].id)).toEqual({ ok: false, error: 'forbidden' });
            const first = await claim(current, automations[0].id);
            const second = await claim(current, automations[1].id);
            expect(first.ok && second.ok).toBe(true);
            const runs = [first, second].map(({ value }) => ({ runId: value.runId as string, claimToken: value.claimToken as string }));
            for (const run of runs) expect(await current('automation-run-start', run)).toMatchObject({ ok: true });

            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
            expect(await claim(current, automations[2].id)).toEqual({ ok: false, error: 'forbidden' });
            expect(await current('automation-missed-record', {
                automationId: automations[2].id, generation: 1, firstMissedAt: Date.now() - 60_000, missedCount: 1, failureCode: 'MISSED_OFFLINE',
            })).toEqual({ ok: false, error: 'forbidden' });
            expect(await db.automationRun.count({ where: { automationId: automations[2].id } })).toBe(0);
            expect(await current('automation-run-heartbeat', runs[0])).toMatchObject({ ok: true });
            // A claimed run reports only a conversation of this work machine.
            expect(await report(current, runs[0], 'unattached-report-target', 'report-unattached')).toEqual({ ok: false, error: 'target-mismatch' });
            expect(await report(current, runs[0], 'protected-session', 'report-first')).toMatchObject({ ok: true });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: runs[0].runId } }))
                .toMatchObject({ status: 'COMPLETED', sessionId: 'protected-session' });

            await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
            expect(await current('automation-run-heartbeat', runs[1])).toEqual({ ok: false, error: 'forbidden' });
            expect(await report(current, runs[1], null, 'report-frozen')).toEqual({ ok: false, error: 'forbidden' });
            // The handoff waits for the run's lease, which the frozen generation can no longer extend.
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe('open-automation-runs');
            await db.automationRun.update({ where: { id: runs[1].runId }, data: { runLeaseExpiresAt: new Date(Date.now() - 1) } });
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            expect(await report(current, runs[1], null, 'report-old-generation')).toEqual({ ok: false, error: 'forbidden' });
            expect((await db.automationRun.findUniqueOrThrow({ where: { id: runs[1].runId } })).status).toBe('RUNNING');
            expect(await claim(worker({ ...replacement, purpose: 'daemon', expiresAt }), automations[2].id)).toMatchObject({ ok: true });
        } finally {
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
            await db.project.delete({ where: { id: project.id } });
            vi.unstubAllEnvs();
        }
    });

    it('records the replacement first execution when its socket claims automation work, not when a claim is refused', async () => {
        vi.stubEnv('SAYCODE_AUTOMATION_ENABLED', 'true');
        const project = await db.project.create({ data: {
            accountId, name: 'replacement-claims', automationViewerKeyVersion: 1, config: { machineId },
        } });
        await db.machine.update({ where: { id: machineId }, data: { automationKeyVersion: 1 } });
        const keys = {
            viewerKeyVersion: 1, viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
        };
        const automation = await db.automation.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, payloadVersion: 1,
            payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer-replacement', enabledAt: new Date(Date.now() - 60_000), ...keys,
        } });
        const followup = await db.sessionFollowup.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, sessionId: 'replacement-followup-session',
            payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer-followup', totalRounds: 3, currentRound: 1,
            responseBoundarySeq: 0, lastObservedSeq: 0, ...keys,
        } });
        const handlers = new Map<string, (data: unknown, callback: (result: unknown) => void) => Promise<void>>();
        automationSocketHandler(accountId, machineId, { on: (event: string, handler: never) => handlers.set(event, handler) } as never,
            { ...replacement, purpose: 'daemon', expiresAt: Date.now() + 60_000 } as never);
        const send = (event: string, data: object) => new Promise<{ ok: boolean; error?: string }>(resolve =>
            void handlers.get(event)!(data, resolve as never));
        const firstExecution = async () => (await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt;
        try {
            expect(await freezeWorkMachineExecution(db, original)).toBe(true);
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);

            expect(await send('automation-claim', { automationId: automation.id, generation: 99, scheduledFor: Date.now() }))
                .toEqual({ ok: false, error: 'claim-denied' });
            expect(await send('session-followup-claim', { wireVersion: SESSION_FOLLOWUP_WIRE_VERSION, followupId: followup.id, generation: 1, step: 99 }))
                .toEqual({ ok: false, error: 'claim-denied' });
            expect(await firstExecution()).toBeNull();

            expect(await send('session-followup-claim', { wireVersion: SESSION_FOLLOWUP_WIRE_VERSION, followupId: followup.id, generation: 1, step: 1 }))
                .toMatchObject({ ok: true });
            expect(await firstExecution()).not.toBeNull();

            await db.workMachineExecution.update({ where: { machineId }, data: { firstExecutionAt: null } });
            expect(await send('automation-claim', { automationId: automation.id, generation: 1, scheduledFor: Date.now() }))
                .toMatchObject({ ok: true });
            expect(await firstExecution()).not.toBeNull();
            expect(await restoreWorkMachineExecution(db, replacement, original.deviceId)).toBe('first-execution-recorded');
        } finally {
            await db.project.delete({ where: { id: project.id } });
            vi.unstubAllEnvs();
        }
    });

    it('serves automation questions to the current device credential only: claims stop at drain and record the first execution', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        vi.stubEnv('SAYCODE_AUTOMATION_ENABLED', 'true');
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const project = await db.project.create({ data: {
            accountId, name: 'device-questions', automationViewerKeyVersion: 1, config: { machineId },
        } });
        await db.machine.update({ where: { id: machineId }, data: { automationKeyVersion: 1, automationContextIsolationVersion: 1 } });
        const one = (size: number) => Buffer.concat([Buffer.from([1]), Buffer.alloc(size - 1)]).toString('base64');
        const encrypted = { payloadVersion: 6, payloadCiphertext: one(41), viewerKeyId: 'k', viewerKeyVersion: 1,
            viewerKeyEnvelope: one(105), machineKeyVersion: 1, machineKeyEnvelope: one(105) };
        const automation = await db.automation.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, payloadVersion: 6,
            revision: 2, generation: 3, payloadCiphertext: new Uint8Array(1), viewerKeyId: 'k', viewerKeyVersion: 1,
            viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
        } });
        const source = await db.automationRun.create({ data: {
            id: 'question-source', automationId: automation.id, generation: 3, scheduledFor: new Date(0), machineAccountId: accountId, machineId,
            status: 'COMPLETED', claimTokenHash: new Uint8Array(32), claimExpiresAt: new Date(0), claimedAt: new Date(0),
            sessionId: automationExecutionSessionId('question-source'), displaySessionId: 'protected-session',
            executionCreateBodyHash: 'hash', executionSeedMetadata: 'encrypted',
            executionExitReceipt: { version: 1, provider: 'codex', observedAt: 1, receivedAt: 2, providerExitedCleanly: true,
                foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true },
        } });
        const question = await db.automationExecutionQuestion.create({ data: {
            id: crypto.randomUUID(), requestedByAccountId: accountId, automationId: automation.id, sourceRunId: source.id,
            generation: 3, revision: 2, displaySessionId: 'protected-session', machineAccountId: accountId, machineId,
            encrypted, requestHash: 'hash',
        } });
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            automationExecutionRoutes(app as unknown as Fastify);
            const daemon = async (device: typeof original) => {
                const now = Date.now();
                return auth.workMachineExecutionIssuer!.mint({ ...device, purpose: 'daemon', expiresAt: now + 60_000 }, now);
            };
            const queue = `/v1/machines/${machineId}/automation-questions`;
            const list = (token: string) => app.inject({ method: 'GET', url: queue, headers: { authorization: `Bearer ${token}` } });
            const hold = (token: string) => app.inject({
                method: 'PATCH', url: `${queue}/${question.id}`, payload: { holdCode: null }, headers: { authorization: `Bearer ${token}` },
            });
            const claim = (token: string) => app.inject({
                method: 'POST', url: `${queue}/${question.id}/claim`, payload: { claimToken: 'q'.repeat(43) },
                headers: { authorization: `Bearer ${token}` },
            });
            const current = await daemon(original);
            const accountToken = await auth.createToken(accountId);

            expect((await list(accountToken)).statusCode).toBe(403);
            expect((await claim(accountToken)).statusCode).toBe(403);
            expect((await list(await daemon({ ...original, deviceId: 'other-pc' }))).statusCode).toBe(403);
            // A machine outside work-machine authority keeps its account bearer; a device credential cannot reach it.
            await db.machine.create({ data: { id: 'question-legacy-machine', accountId, metadata: 'encrypted' } });
            const legacyQueue = (token: string) => app.inject({
                method: 'GET', url: '/v1/machines/question-legacy-machine/automation-questions', headers: { authorization: `Bearer ${token}` },
            });
            expect((await legacyQueue(current)).statusCode).toBe(403);
            expect((await legacyQueue(accountToken)).statusCode).toBe(200);
            expect((await list(current)).statusCode).toBe(200);

            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
            expect((await list(current)).statusCode).toBe(200);
            expect((await hold(current)).statusCode).toBe(200);
            expect((await claim(current)).statusCode).toBe(403);
            expect(await db.automationRun.count({ where: { id: question.id } })).toBe(0);

            await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
            expect((await list(current)).statusCode).toBe(403);
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            const next = await daemon(replacement);
            const claimed = await claim(next);
            expect(claimed.statusCode).toBe(200);
            expect(claimed.json()).toMatchObject({ runId: question.id, state: 'CLAIMED' });
            expect((await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt).not.toBeNull();
        } finally {
            await app.close();
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
            await db.machine.update({ where: { id: machineId }, data: { automationContextIsolationVersion: 0 } });
            await db.machine.deleteMany({ where: { id: 'question-legacy-machine' } });
            await db.project.delete({ where: { id: project.id } });
            vi.unstubAllEnvs();
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });

    it('accepts session events and push events of a protected conversation only with its current session credential', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const ephemeral = vi.spyOn(eventRouter, 'emitEphemeral').mockImplementation(() => {});
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            enableSessionScopeAuthentication(app as unknown as Fastify, () => null);
            v3SessionEventRoutes(app as unknown as Fastify);
            pushRoutes(app as unknown as Fastify);
            const session = async (device: typeof original) => {
                const now = Date.now();
                return auth.workMachineExecutionIssuer!.mint({
                    ...device, sessionId: 'protected-session', purpose: 'session', expiresAt: now + 60_000,
                }, now);
            };
            const event = (token: string) => app.inject({
                method: 'POST', url: '/v3/sessions/protected-session/events', headers: { authorization: `Bearer ${token}` },
                payload: { eventType: 'session-end', content: 'encrypted' },
            });
            const push = (token: string) => app.inject({
                method: 'POST', url: '/v1/sessions/protected-session/push-event', headers: { authorization: `Bearer ${token}` },
                payload: { kind: 'permission', title: 'title', body: 'body' },
            });
            const events = () => db.sessionEvent.count({ where: { sessionId: 'protected-session' } });
            const current = await session(original);
            const accountToken = await auth.createToken(accountId);

            expect((await event(accountToken)).statusCode).toBe(403);
            expect((await push(accountToken)).statusCode).toBe(403);
            const before = await events();
            expect((await event(current)).statusCode).toBe(200);
            expect(await events()).toBe(before + 1);
            expect((await push(current)).statusCode).toBe(200);

            // In-turn writes continue while draining and stop at the freeze.
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
            expect((await event(current)).statusCode).toBe(200);
            await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
            expect((await event(current)).statusCode).toBe(403);
            expect((await push(current)).statusCode).toBe(403);
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            expect((await event(current)).statusCode).toBe(403);
            expect((await event(await session(replacement))).statusCode).toBe(200);
            expect(await events()).toBe(before + 3);
        } finally {
            ephemeral.mockRestore();
            await app.close();
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });

    it('refuses a session event that names two different conversations', async () => {
        const claims = { ...original, sessionId: 'protected-session', purpose: 'session' as const, expiresAt: Date.now() + 60_000 };
        const act = (payload: object, input: Partial<Parameters<typeof workMachineSocketMayAct>[1]> = {}) => workMachineSocketMayAct(db, {
            accountId, socketMachineId: undefined, socketSessionId: 'protected-session', claims, event: 'usage-report',
            payload, now: Date.now(), ...input,
        });
        expect(await act({ sessionId: 'protected-session' })).toBe(true);
        expect(await act({ sid: 'protected-session', sessionId: 'protected-session' })).toBe(true);
        // The usage handler writes `sessionId`; the check must not read `sid` instead.
        expect(await act({ sid: 'protected-session', sessionId: 'other-conversation' })).toBe(false);
        expect(await act({ sid: 'ordinary-conversation', sessionId: 'protected-session' }, { claims: null, socketSessionId: undefined }))
            .toBe(false);
    });

    it('admits the automation socket events of the current device daemon socket only', async () => {
        const claims = { ...original, purpose: 'daemon' as const, expiresAt: Date.now() + 60_000 };
        const act = (event: string, input: Partial<Parameters<typeof workMachineSocketMayAct>[1]> = {}) => workMachineSocketMayAct(db, {
            accountId, socketMachineId: machineId, claims, event, payload: { automationId: 'any' }, now: Date.now(), ...input,
        });
        for (const event of ['automation-claim', 'automation-run-report', 'automation-sync', 'session-followup-claim']) {
            expect(await act(event)).toBe(true);
        }
        expect(await act('automation-claim', { socketMachineId: 'ordinary-machine' })).toBe(false);
        expect(await act('automation-claim', { claims: { ...claims, purpose: 'session', sessionId: 'protected-session' } as never, socketMachineId: undefined, socketSessionId: 'protected-session' })).toBe(false);
        expect(await act('automation-claim', { claims: null })).toBe(false);
        await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
        expect(await act('automation-run-report')).toBe(false);
    });

    it('lets the current device run script automation over HTTP: claims stop at drain, claimed runs report until the freeze', async () => {
        const priorSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = 'work-machine-loopback-test-only';
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const project = await db.project.create({ data: { accountId, name: 'device-script' } });
        const automation = await db.automation.create({ data: {
            projectId: project.id, ownerAccountId: accountId, machineAccountId: accountId, machineId, payloadVersion: 3,
            payloadCiphertext: new Uint8Array(1), viewerKeyId: 'viewer', viewerKeyVersion: 1,
            viewerKeyEnvelope: new Uint8Array(1), machineKeyVersion: 1, machineKeyEnvelope: new Uint8Array(1),
        } });
        await db.scriptArtifact.create({ data: { id: 'device-artifact', projectId: project.id, digest: 'digest', encrypted: {} } });
        await db.scriptAutomationRevision.create({ data: {
            automationId: automation.id, revision: 1, artifactId: 'device-artifact', digest: 'digest',
            payloadCiphertext: 'encrypted', admission: {}, ready: true,
        } });
        const invocation = (id: string, status: string, token?: string) => db.scriptInvocation.create({ data: {
            id, automationId: automation.id, revision: 1, generation: 1, trigger: 'manual', requestedBy: accountId,
            idempotencyKey: id, bodyHash: 'hash', snapshot: { machineId, machineAccountId: accountId }, inputCiphertext: 'encrypted',
            createdAt: Date.now(), status, ...(token ? { claimHash: createHash('sha256').update(token).digest('hex'), leaseExpiresAt: Date.now() + 300_000 } : {}),
        } });
        const queued = await invocation('device-queued', 'QUEUED');
        const runningToken = 'r'.repeat(43);
        const frozenToken = 'f'.repeat(43);
        await invocation('device-running', 'RUNNING', runningToken);
        await invocation('device-running-frozen', 'RUNNING', frozenToken);
        try {
            await auth.init();
            enableAuthentication(app as unknown as Fastify);
            scriptAutomationRoutes(app as unknown as Fastify, { enabled: () => true, transaction: work => db.$transaction(work) });
            const daemon = async (device: typeof original) => {
                const now = Date.now();
                return auth.workMachineExecutionIssuer!.mint({ ...device, purpose: 'daemon', expiresAt: now + 60_000 }, now);
            };
            const current = await daemon(original);
            const call = (token: string, method: 'GET' | 'POST', path: string, payload?: object, target = machineId) => app.inject({
                method, url: `/v1/machines/${target}${path}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}),
            });
            // The cursor skips this test's automation, whose fixture admission is not a valid listing.
            const list = (token: string, target?: string) => call(token, 'GET', `/script-automations?after=${automation.id}`, undefined, target);
            const claim = (token: string) => call(token, 'POST', `/script-automations/${automation.id}/claim`, {});
            const heartbeat = (token: string, runId: string, claimToken: string) =>
                call(token, 'POST', `/script-runs/${runId}/heartbeat`, { token: claimToken });
            const abandon = (token: string, runId: string, claimToken: string) =>
                call(token, 'POST', `/script-runs/${runId}/abandon`, { token: claimToken });

            expect((await list(current)).statusCode).toBe(200);
            expect((await list(await auth.createToken(accountId))).statusCode).toBe(403);
            expect((await list(current, 'ordinary-machine')).statusCode).toBe(403);
            expect((await list(await daemon({ ...original, deviceId: 'other-pc' }))).statusCode).toBe(403);

            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: new Date() } });
            expect((await claim(current)).statusCode).toBe(403);
            expect(await db.scriptInvocation.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'QUEUED', claimHash: null });
            expect((await heartbeat(current, 'device-running', runningToken)).statusCode).toBe(200);
            expect((await abandon(current, 'device-running', runningToken)).statusCode).toBe(200);
            expect((await db.scriptInvocation.findUniqueOrThrow({ where: { id: 'device-running' } })).status).not.toBe('RUNNING');

            await db.workMachineExecution.update({ where: { machineId }, data: { frozenAt: new Date() } });
            expect((await heartbeat(current, 'device-running-frozen', frozenToken)).statusCode).toBe(403);
            expect((await abandon(current, 'device-running-frozen', frozenToken)).statusCode).toBe(403);
            // The handoff waits for the run's lease, which the frozen generation can no longer extend.
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe('open-automation-runs');
            await db.scriptInvocation.update({ where: { id: 'device-running-frozen' }, data: { leaseExpiresAt: Date.now() - 1 } });
            expect(await replaceWorkMachineExecution(db, original, replacement.deviceId)).toBe(true);
            expect((await abandon(current, 'device-running-frozen', frozenToken)).statusCode).toBe(403);
            expect((await db.scriptInvocation.findUniqueOrThrow({ where: { id: 'device-running-frozen' } })).status).toBe('RUNNING');
            const next = await daemon(replacement);
            expect((await list(next)).statusCode).toBe(200);
            const firstExecution = async () => (await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } })).firstExecutionAt;
            expect(await firstExecution()).toBeNull();
            // The replacement claims the run the old generation left queued: it ran work, so the way back closes.
            await db.project.update({ where: { id: project.id }, data: {
                config: { machineId }, automationViewerPublicKey: new Uint8Array(32), automationViewerKeyVersion: 1,
            } });
            await db.machine.update({ where: { id: machineId }, data: {
                automationPublicKey: new Uint8Array(32), automationKeyVersion: 1, automationProtocolVersion: SCRIPT_AUTOMATION_PROTOCOL_VERSION,
            } });
            await db.scriptInvocation.update({ where: { id: queued.id }, data: {
                snapshot: { machineId, machineAccountId: accountId, artifactId: 'device-artifact' },
            } });
            const claimed = await claim(next);
            expect(claimed.statusCode).toBe(200);
            expect(claimed.json().claim).not.toBeNull();
            expect(await firstExecution()).not.toBeNull();
            // A claim with nothing to run (the automation is paused) records nothing.
            await db.workMachineExecution.update({ where: { machineId }, data: { firstExecutionAt: null } });
            await db.automation.update({ where: { id: automation.id }, data: { paused: true } });
            const empty = await claim(next);
            expect(empty.statusCode).toBe(200);
            expect(empty.json().claim).toBeNull();
            expect(await firstExecution()).toBeNull();
        } finally {
            await db.machine.update({ where: { id: machineId }, data: { automationPublicKey: null, automationProtocolVersion: 1 } });
            await app.close();
            await db.workMachineExecution.update({ where: { machineId }, data: { drainingAt: null } });
            await db.project.delete({ where: { id: project.id } });
            if (priorSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = priorSecret;
        }
    });
});
