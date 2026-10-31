import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import nacl from 'tweetnacl';
import { signOwnership, ownershipDigest, sessionCreateBodyHash, rotationSha256, sharedMachineRotationFixture, OwnershipCallerBindingSchema } from '@slopus/happy-wire';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from './types';
import { createOwnedSpawnRuntime, createOwnedStartGuard } from './ownedSpawnRuntime';
import { registerOwnedSpawnRpc } from './ownedSpawnRpc';
import { createOwnedSpawnJournal } from './ownedSpawnJournal';
import { ownedSpawnRecordSchema } from './ownedSpawn';
const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(options: { parent?: string; spawn?: Record<string, unknown> } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'owned-runtime-')); homes.push(home);
    const keys = nacl.sign.keyPair(), now = Date.now();
    const signed = { version: 1, issuer: 'https://studio.test', audience: 'https://happy.test', keyId: await rotationSha256(keys.publicKey), issuedAt: now, expiresAt: now + 60_000 };
    const spawn = options.spawn ?? { directory: '/project', agent: 'codex' };
    const scope = { intentId: 'intent', operationId: 'operation', creationRequestId: 'creation', ownershipPolicy: 'prefer-owned', subject: { issuer: signed.issuer, userId: 'person' },
        companyId: null, projectId: null, machineId: 'machine', machineAccountId: 'account', sessionAccountId: 'account', parentHubSessionId: options.parent ?? null, spawnDigest: await ownershipDigest(spawn) };
    const intent = signOwnership({ ...signed, ...scope, type: 'saycode-session-ownership-intent' }, keys.secretKey);
    let raw: Record<string, unknown> | null = null, tracked: TrackedSession | undefined;
    let posts = 0, starts = 0, lose = false, current = true, alive = true;
    let onStart: (() => Promise<void>) | undefined;
    let lastStart: unknown;
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url).endsWith('/v1/account/profile')) return Response.json({ id: 'account' });
        if (String(url).includes('/v2/sessions')) return Response.json({ sessions: raw ? [raw] : [], hasNext: false, nextCursor: null });
        expect(String(url)).toBe('https://happy.test/v1/sessions'); posts++;
        const body = JSON.parse(String(options?.body));
        raw = { id: 'session', seq: 0, metadataVersion: 0, agentStateVersion: 0, metadata: body.metadata,
            agentState: body.executionProof || body.ownershipProof ? body.agentState ?? null : null, dataEncryptionKey: body.dataEncryptionKey ?? null };
        if (lose) throw new Error('lost ACK');
        const { ownershipProof, executionProof: _executionProof, ...create } = body;
        return Response.json({ session: raw, ...(ownershipProof ? { ownership: { sessionId: 'session', ownershipBindingId: 'binding', registrationState: 'pending', createDigest: await sessionCreateBodyHash(create) } } : {}) });
    }) as typeof fetch;
    const persist = vi.fn(async () => ({ status: 'committed' as const }));
    const build = (extra: Partial<Parameters<typeof createOwnedSpawnRuntime>[0]> = {}) => createOwnedSpawnRuntime({ home, happyOrigin: signed.audience, env: { HAPPY_SESSION_OWNERSHIP_ENABLED: '1', HAPPY_SESSION_OWNERSHIP_ISSUER: signed.issuer,
        HAPPY_SESSION_OWNERSHIP_AUDIENCE: signed.audience, HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: JSON.stringify({ [signed.keyId]: Buffer.from(keys.publicKey).toString('base64url') }) },
        registration: async () => { if (!current) throw new Error('identity-changed'); return { machineId: 'machine', epoch: 'registration', credentials: { token: 'synthetic-machine-bearer', encryption: { type: 'legacy', secret: new Uint8Array(32) } } }; },
        metadata: () => ({ path: '/project', host: 'box', machineId: 'machine', flavor: 'codex' }) as Metadata,
        rotation: async () => null, fetch: fetcher, persist,
        tracked: () => tracked, live: s => alive && s.pid > 0,
        start: async (options, launch) => {
            lastStart = options; void launch;
            starts++; expect(options.reconnectEnvironment?.HAPPY_RECONNECT_SESSION_ID).toBe('session');
            expect(JSON.stringify(options)).not.toContain('signature'); expect(JSON.stringify(options)).not.toContain('synthetic-machine-bearer');
            tracked = { pid: 123, happySessionId: 'session', startedBy: 'daemon', directory: '/project' };
            await onStart?.();
            return { type: 'success', sessionId: 'session' };
        },
        ...extra,
    });
    return { home, spawn, intent, build, persist, onStart: (hook: () => Promise<void>) => { onStart = hook; },
        setAlive: (value: boolean) => { alive = value; }, lastStart: () => lastStart, journal: createOwnedSpawnJournal(home), clearAgentState: () => { raw!.agentState = null }, counts: () => ({ posts, starts }), lose: () => { lose = true }, logout: () => { current = false },
        proof: (p: { sessionCreateBodyHash: string; sessionTagHash: string }) => signOwnership({ ...signed, ...scope, type: 'saycode-session-ownership',
            nonce: Buffer.alloc(32, 1).toString('base64url'), createBodyHash: p.sessionCreateBodyHash, tagHash: p.sessionTagHash }, keys.secretKey) };
}
it('transports the signed snapshot through encrypted machine RPC and answers a mock main nonce verifier from live launch state', async () => {
    const f = await fixture(), runtime = f.build(), handlers = new Map<string, (raw: unknown) => Promise<any>>();
    registerOwnedSpawnRpc((name, handler) => handlers.set(name, handler), runtime);
    const rpc = (name: string, body: unknown) => handlers.get(name)!(body);
    expect(await rpc('owned-spawn-capabilities', { spawn: f.spawn })).toEqual({ ownedSpawnPrepareV1: true });
    const p = await rpc('prepare-owned-spawn', { intent: f.intent, spawn: f.spawn });
    const c = await rpc('commit-owned-spawn', { creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof(p) });
    expect(c).toMatchObject({ sessionId: 'session', ownershipOutcome: 'pending' });
    const s = await rpc('start-owned-spawn', { creationRequestId: 'creation', preparationId: p.preparationId, sessionId: 'session' });
    expect(s.state).toBe('started'); expect(f.persist).toHaveBeenCalledOnce();
    const nonce = 'main-verifier-nonce';
    const reply = await rpc('agent-caller-binding', { sessionId: 'session', nonce });
    expect(reply.nonce).toBe(nonce); expect(reply.caller).toMatchObject({ sessionId: 'session', machineId: 'machine', happyAccountId: 'account', scope: '/project', depth: 0 });
    const restarted = f.build();
    const fresh = await restarted.callerBinding({ sessionId: 'session', nonce }) as typeof reply;
    expect(fresh.caller.callerBindingId).not.toBe(reply.caller.callerBindingId);
    expect(f.counts()).toEqual({ posts: 1, starts: 1 });
});
it('answers non-journal sources only from daemon-vouched launch bindings (T1c-b2 H2)', async () => {
    const f = await fixture(), nonce = 'main-verifier-nonce';
    await expect(f.build().callerBinding({ sessionId: 'terminal-source', nonce })).rejects.toThrow('caller-unavailable');
    const query = vi.fn(async (raw: unknown) => ({ version: 1, nonce, caller: { sessionId: (raw as { sessionId: string }).sessionId } }));
    const runtime = f.build({ launchCallers: { query } });
    expect(await runtime.callerBinding({ sessionId: 'launched-source', nonce })).toEqual({ version: 1, nonce, caller: { sessionId: 'launched-source' } });
    expect(query).toHaveBeenCalledWith({ sessionId: 'launched-source', nonce });
});
it('rejects forged signatures and local registration changes without a POST', async () => {
    const f = await fixture(), runtime = f.build();
    await expect(runtime.prepare({ spawn: f.spawn, intent: { ...f.intent, signature: Buffer.alloc(64).toString('base64url') } })).rejects.toThrow();
    const p = await runtime.prepare({ spawn: f.spawn, intent: f.intent }); f.logout();
    await expect(runtime.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof(p) })).rejects.toThrow();
    expect(f.counts().posts).toBe(0);
});
it('recovers exact encrypted create after lost response and restart, starts pending without a second POST', async () => {
    const f = await fixture(), runtime = f.build();
    const p = await runtime.prepare({ spawn: f.spawn, intent: f.intent }); f.lose();
    await runtime.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof(p) });
    const next = f.build();
    expect(await next.status({ creationRequestId: 'creation' })).toMatchObject({ state: 'created', sessionId: 'session', ownershipOutcome: 'pending' });
    await next.start({ creationRequestId: 'creation', preparationId: p.preparationId, sessionId: 'session' });
    expect(f.counts()).toEqual({ posts: 1, starts: 1 });
});

it('recovers an unsigned creation with null server agentState after a lost response and daemon restart without duplicating it', async () => {
    const f = await fixture(), runtime = f.build();
    const p = await runtime.prepare({ spawn: f.spawn, intent: f.intent }); f.lose();
    const request = { creationRequestId: 'creation', preparationId: p.preparationId, unprovenReason: 'ownership-timeout' };
    expect(await runtime.commit(request)).toMatchObject({ state: 'committing' });
    const next = f.build();
    expect(await next.status({ creationRequestId: 'creation' })).toMatchObject({ state: 'created', sessionId: 'session', ownershipOutcome: 'unproven' });
    expect(await next.commit(request)).toMatchObject({ sessionId: 'session' });
    const start = { creationRequestId: 'creation', preparationId: p.preparationId, sessionId: 'session' };
    expect(await next.start(start)).toMatchObject({ state: 'started', sessionId: 'session' });
    await next.start(start);
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ id: 'session', agentState: null }));
    expect(f.counts()).toEqual({ posts: 1, starts: 1 });
});

it.each(['execution', 'ownership'])('keeps agentState bound during %s proof recovery', async kind => {
    if (kind === 'execution') vi.spyOn(Date, 'now').mockReturnValue(sharedMachineRotationFixture.executionProof.ticket.body.issuedAt);
    const f = await fixture(), runtime = f.build();
    const p = await runtime.prepare({ spawn: f.spawn, intent: f.intent });
    if (kind === 'execution') {
        // Seed the durable execution-proof snapshot normally supplied by the rotation port.
        const record = (await f.journal.read('creation'))!;
        record.snapshot!.executionProof = sharedMachineRotationFixture.executionProof as NonNullable<typeof record.snapshot>['executionProof'];
        await f.journal.write(record);
    }
    f.lose();
    await runtime.commit({ creationRequestId: 'creation', preparationId: p.preparationId,
        ...(kind === 'execution' ? { unprovenReason: 'ownership-timeout' } : { ownershipProof: f.proof(p) }) });
    f.clearAgentState();
    const next = f.build();
    expect(await next.status({ creationRequestId: 'creation' })).toMatchObject({ state: 'committing' });
    expect(f.counts()).toEqual({ posts: 1, starts: 0 });
});

it.each([
    { type: 'error', code: 'daemon-restarting', errorMessage: 'retry later' },
    { type: 'requestToApproveDirectoryCreation', directory: '/project' },
    { type: 'error', errorMessage: 'validation failed' },
] as const)('classifies only pre-dispatch refusals ($type)', async result => {
    const guard = createOwnedStartGuard(), options = { directory: '/project', agent: 'codex' as const };
    await expect(guard.start(options, async () => result)).rejects.toThrow('owned-start-refused');
    expect(await guard.start(options, async () => { guard.submitted(options); expect(guard.wasSubmitted(options)).toBe(true); return result; })).toBe(result);
    expect(guard.wasSubmitted(options)).toBe(false);
    await expect(guard.start(options, async () => { throw new Error('uncertain'); })).rejects.toThrow('uncertain');
});

type Caller = z.infer<typeof OwnershipCallerBindingSchema>;
const callerKey = () => Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url');
const hostCaller = (fields: Partial<Caller> & { sessionId: string }): Caller => ({ callerBindingId: `${fields.sessionId}-binding`, runtimeId: `${fields.sessionId}-runtime`,
    machineId: 'machine', happyAccountId: 'account', scope: '/project', depth: 0, hostEpoch: `${fields.sessionId}-epoch`, callerPublicKey: callerKey(), ...fields });
/** Daemon-vouched launch bindings (agentCallerLaunches) as seen by the owned runtime. */
function hostCallers(available = true) {
    const callers = new Map<string, Caller>();
    return { callers, available: () => available, currentCaller: async (sessionId: string) => callers.get(sessionId) ?? null,
        query: vi.fn(async (raw: unknown) => {
            const { sessionId, nonce } = raw as { sessionId: string; nonce: string };
            const caller = callers.get(sessionId); if (!caller) throw new Error('caller-unavailable');
            return { version: 1, nonce, caller };
        }) };
}
async function createdSession(f: Awaited<ReturnType<typeof fixture>>, runtime: ReturnType<Awaited<ReturnType<typeof fixture>>['build']>) {
    const p = await runtime.prepare({ spawn: f.spawn, intent: f.intent });
    await runtime.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof(p) });
    return { creationRequestId: 'creation', preparationId: p.preparationId, sessionId: 'session' };
}
describe('owned child host custody (T1c-b2 H3)', () => {
    it('hands the child host its own binding at provider start and reports that runtime as started', async () => {
        const f = await fixture(), hosts = hostCallers(), runtime = f.build({ launchCallers: hosts });
        let lineage: unknown;
        f.onStart(async () => {
            lineage = await runtime.launchLineage('session');
            hosts.callers.set('session', hostCaller({ sessionId: 'session', runtimeId: 'child-host-runtime' }));
        });
        const s = await runtime.start(await createdSession(f, runtime)) as Record<string, any>;
        expect(lineage).toEqual({ sessionId: 'session', scope: '/project', depth: 0 });
        expect(s).toMatchObject({ state: 'started', providerRuntimeId: 'child-host-runtime', caller: hosts.callers.get('session') });
        // Main verifies the binding the child host holds the key for; the daemon keeps no second key for it.
        expect((await runtime.callerBinding({ sessionId: 'session', nonce: 'main-verifier-nonce' }) as any).caller).toEqual(hosts.callers.get('session'));
        expect(hosts.query).toHaveBeenCalledOnce();
        expect(await runtime.launchLineage('session')).toEqual({ sessionId: 'session', scope: '/project', depth: 0 });
        expect(f.counts()).toEqual({ posts: 1, starts: 1 });
    });
    it('derives a grandchild lineage from its parent\'s current binding, never from the parent contact', async () => {
        const f = await fixture({ parent: 'parent' }), hosts = hostCallers(), runtime = f.build({ launchCallers: hosts });
        const parent = hostCaller({ sessionId: 'parent', depth: 1 });
        hosts.callers.set('parent', parent);
        let lineage: unknown;
        f.onStart(async () => {
            lineage = await runtime.launchLineage('session');
            hosts.callers.set('session', hostCaller({ sessionId: 'session', depth: 2 }));
        });
        const s = await runtime.start(await createdSession(f, runtime)) as Record<string, any>;
        expect(lineage).toEqual({ sessionId: 'session', scope: '/project', depth: 2, parentCallerPublicKey: parent.callerPublicKey });
        expect(s.state).toBe('started');
        expect(s.caller.callerBindingId).not.toBe(parent.callerBindingId);
    });
    it('refuses before launch when the parent has no current binding', async () => {
        const f = await fixture({ parent: 'parent' }), runtime = f.build({ launchCallers: hostCallers() });
        await expect(runtime.start(await createdSession(f, runtime))).rejects.toThrow();
        expect(f.counts()).toEqual({ posts: 1, starts: 0 });
    });
    it.each([
        ['the parent\'s key', (parent: Caller) => ({ ...parent, sessionId: 'session', depth: 2 })],
        ['another session\'s binding', () => hostCaller({ sessionId: 'other', depth: 2 })],
    ])('does not report started with a binding that is not the child\'s own (%s)', async (_name, bindingFor) => {
        const f = await fixture({ parent: 'parent' }), hosts = hostCallers(), runtime = f.build({ launchCallers: hosts, hostBindingWaitMs: 0 });
        const parent = hostCaller({ sessionId: 'parent', depth: 1 });
        hosts.callers.set('parent', parent);
        f.onStart(async () => { hosts.callers.set('session', bindingFor(parent)); });
        expect(await runtime.start(await createdSession(f, runtime))).toMatchObject({ state: 'starting' });
        expect(await runtime.status({ creationRequestId: 'creation' })).toMatchObject({ state: 'starting' });
        expect(f.counts()).toEqual({ posts: 1, starts: 1 });
    });
    it('recovers a late child binding through status without starting the provider again', async () => {
        const f = await fixture(), hosts = hostCallers(), runtime = f.build({ launchCallers: hosts, hostBindingWaitMs: 0 });
        const start = await createdSession(f, runtime);
        expect(await runtime.start(start)).toMatchObject({ state: 'starting' });
        expect(await runtime.start(start)).toMatchObject({ state: 'starting' });
        hosts.callers.set('session', hostCaller({ sessionId: 'session', runtimeId: 'late-runtime' }));
        expect(await runtime.status({ creationRequestId: 'creation' })).toMatchObject({ state: 'started', providerRuntimeId: 'late-runtime' });
        expect(f.counts()).toEqual({ posts: 1, starts: 1 });
    });
    it('after a daemon restart recovers the same operation by status only: no new creation, start or daemon key', async () => {
        const f = await fixture(), runtime = f.build({ launchCallers: hostCallers(), hostBindingWaitMs: 0 });
        const start = await createdSession(f, runtime);
        expect(await runtime.start(start)).toMatchObject({ state: 'starting' });
        const restarted = f.build({ launchCallers: hostCallers(), hostBindingWaitMs: 0 });
        expect(await restarted.status({ creationRequestId: 'creation' })).toMatchObject({ state: 'starting', sessionId: 'session' });
        expect(await restarted.start(start)).toMatchObject({ state: 'starting' });
        expect(await restarted.commit({ creationRequestId: 'creation', preparationId: start.preparationId, ownershipProof: (await f.journal.read('creation'))!.proof }))
            .toMatchObject({ state: 'starting' });
        await expect(restarted.callerBinding({ sessionId: 'session', nonce: 'main-verifier-nonce' })).rejects.toThrow('caller-unavailable');
        expect(f.counts()).toEqual({ posts: 1, starts: 1 });
    });
    it('never lets a resumed owned session with unreadable lineage bind as depth 0', async () => {
        const f = await fixture({ parent: 'parent' }), hosts = hostCallers(), runtime = f.build({ launchCallers: hosts, hostBindingWaitMs: 0 });
        hosts.callers.set('parent', hostCaller({ sessionId: 'parent', depth: 1 }));
        expect(await runtime.start(await createdSession(f, runtime))).toMatchObject({ state: 'starting' });
        // Daemon restart: the parent binding is gone and the start never confirmed a child binding.
        expect(await f.build({ launchCallers: hostCallers(), hostBindingWaitMs: 0 }).launchLineage('session')).toBe('unknown');
        expect(await f.build({ launchCallers: hostCallers() }).launchLineage('unrelated')).toBeNull();
    });
    it('advertises owned-child contact separately from owned spawn and only for a supported spawn', async () => {
        const f = await fixture();
        expect(await f.build({ launchCallers: hostCallers() }).capabilities({ spawn: f.spawn })).toEqual({ ownedSpawnPrepareV1: true, ownedChildOwnerContactV1: true });
        expect(await f.build({ launchCallers: hostCallers() }).capabilities({ spawn: { ...f.spawn, agent: 'gemini' } }))
            .toEqual({ ownedSpawnPrepareV1: false, ownedChildOwnerContactV1: false });
        // Switch off or contact unconfigured: exactly the existing answer.
        expect(await f.build({ launchCallers: hostCallers(false) }).capabilities({ spawn: f.spawn })).toEqual({ ownedSpawnPrepareV1: true });
    });
    it('keeps the existing daemon-held binding when owner contact is unavailable', async () => {
        const f = await fixture(), hosts = hostCallers(false), runtime = f.build({ launchCallers: hosts });
        const s = await runtime.start(await createdSession(f, runtime)) as Record<string, any>;
        expect(s.state).toBe('started');
        expect(await runtime.launchLineage('session')).toBeNull();
        const reply = await runtime.callerBinding({ sessionId: 'session', nonce: 'main-verifier-nonce' }) as any;
        expect(reply.caller.runtimeId).toBe(s.providerRuntimeId);
        expect(hosts.query).not.toHaveBeenCalled();
    });
});

describe('custody fixed at start survives trust changes (H3-R1-01)', () => {
    it('host custody after trust is removed and the daemon restarts: no daemon key, stays starting', async () => {
        const f = await fixture(), runtime = f.build({ launchCallers: hostCallers(), hostBindingWaitMs: 0 });
        const start = await createdSession(f, runtime);
        expect(await runtime.start(start)).toMatchObject({ state: 'starting' });
        for (const restarted of [f.build({ launchCallers: hostCallers(false), hostBindingWaitMs: 0 }), f.build({ hostBindingWaitMs: 0 })]) {
            expect(await restarted.status({ creationRequestId: 'creation' })).toMatchObject({ state: 'starting' });
            expect(await restarted.start(start)).toMatchObject({ state: 'starting' });
            expect(await restarted.commit({ creationRequestId: 'creation', preparationId: start.preparationId, ownershipProof: (await f.journal.read('creation'))!.proof }))
                .toMatchObject({ state: 'starting' });
            await expect(restarted.callerBinding({ sessionId: 'session', nonce: 'main-verifier-nonce' })).rejects.toThrow('caller-unavailable');
        }
        expect(await f.journal.read('creation')).toMatchObject({ state: 'starting', callerCustody: 'host' });
        expect((await f.journal.read('creation'))!.caller).toBeUndefined();
        expect(f.counts()).toEqual({ posts: 1, starts: 1 });
    });
    it('daemon custody after trust is added and the daemon restarts: keeps its own custody and an aligned receipt', async () => {
        const f = await fixture(), runtime = f.build({ launchCallers: hostCallers(false) });
        const start = await createdSession(f, runtime);
        f.setAlive(false);
        expect(await runtime.start(start)).toMatchObject({ state: 'starting' });
        f.setAlive(true);
        const hosts = hostCallers(), restarted = f.build({ launchCallers: hosts });
        const s = await restarted.status({ creationRequestId: 'creation' }) as Record<string, any>;
        expect(s).toMatchObject({ state: 'started' });
        expect(s.caller.runtimeId).toBe(s.providerRuntimeId);
        expect(await restarted.start(start)).toMatchObject({ state: 'started', providerRuntimeId: s.providerRuntimeId });
        expect(await restarted.commit({ creationRequestId: 'creation', preparationId: start.preparationId, ownershipProof: (await f.journal.read('creation'))!.proof }))
            .toMatchObject({ state: 'started' });
        expect((await restarted.callerBinding({ sessionId: 'session', nonce: 'main-verifier-nonce' }) as any).caller).toEqual(s.caller);
        expect(hosts.query).not.toHaveBeenCalled();
        // Its host may not take a second, host-held binding for the same session.
        expect(await restarted.launchLineage('session')).toBe('unknown');
        expect(Object.keys((await f.journal.read('creation'))!)).not.toContain('callerCustody');
        expect(f.counts()).toEqual({ posts: 1, starts: 1 });
    });
});
describe('host custody launches skip tmux (H3-R1-02)', () => {
    it('an owned start with TMUX_SESSION_NAME is a pipe launch and reaches started with its own binding', async () => {
        const spawn = { directory: '/project', agent: 'codex', environmentVariables: { TMUX_SESSION_NAME: 'work' } };
        const f = await fixture({ spawn }), hosts = hostCallers(), runtime = f.build({ launchCallers: hosts });
        let pipeOnly: boolean | undefined;
        f.onStart(async () => {
            pipeOnly = runtime.pipeOnlyLaunch(f.lastStart() as never);
            hosts.callers.set('session', hostCaller({ sessionId: 'session', runtimeId: 'tmux-profile-runtime' }));
        });
        expect(await runtime.start(await createdSession(f, runtime))).toMatchObject({ state: 'started', providerRuntimeId: 'tmux-profile-runtime' });
        expect(pipeOnly).toBe(true);
        expect((f.lastStart() as { environmentVariables?: Record<string, string> }).environmentVariables?.TMUX_SESSION_NAME).toBe('work');
    });
    it('a daemon custody start keeps the existing launch choice', async () => {
        const spawn = { directory: '/project', agent: 'codex', environmentVariables: { TMUX_SESSION_NAME: 'work' } };
        const f = await fixture({ spawn }), runtime = f.build({ launchCallers: hostCallers(false) });
        let pipeOnly: boolean | undefined;
        f.onStart(async () => { pipeOnly = runtime.pipeOnlyLaunch(f.lastStart() as never); });
        expect(await runtime.start(await createdSession(f, runtime))).toMatchObject({ state: 'started' });
        expect(pipeOnly).toBe(false);
    });
    it('the daemon skips tmux for a pipe-only owned launch', async () => {
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(new URL('./run.ts', import.meta.url), 'utf8');
        expect(source).toMatch(/if \(!tmuxAvailable \|\| tmuxSessionName === undefined \|\| ownerPipeRequired\)/);
        expect(source).toContain('const ownerPipeRequired = ownedPipeOnlyLaunch?.(options) === true;');
        expect(source).toContain('ownedPipeOnlyLaunch = options => ownedSpawn.pipeOnlyLaunch(options);');
    });
});

describe('journal compatibility with a daemon from before H3 (H3-R2-01)', () => {
    // origin/main's record schema is this one without the H3 callerCustody field (strict).
    const preH3Schema = ownedSpawnRecordSchema.omit({ callerCustody: true }).strict();
    it.each([
        ['switch off', {}],
        ['owner contact unconfigured', { launchCallers: hostCallers(false) }],
    ])('writes daemon-custody records the pre-H3 schema still reads (%s)', async (_name, extra) => {
        const f = await fixture(), runtime = f.build(extra);
        expect(await runtime.start(await createdSession(f, runtime))).toMatchObject({ state: 'started' });
        const directory = join(f.home, 'owned-spawns'), [name] = await readdir(directory);
        // The raw file, as a daemon from before H3 would read it.
        const raw = JSON.parse(await readFile(join(directory, name), 'utf8'));
        expect(() => preH3Schema.parse(raw)).not.toThrow();
        expect(raw).not.toHaveProperty('callerCustody');
    });
});

/** A damaged journal file beside the real records; the name has the journal's shape but no record behind it. */
async function damage(home: string, name: string, content: string) {
    await writeFile(join(home, 'owned-spawns', createHash('sha256').update(name).digest('hex') + '.json'), content, { mode: 0o600 });
}
describe('owned-spawn journal listing', () => {
    it('list() still refuses a damaged file; entries() reports it with the session it legibly names', async () => {
        const f = await fixture(), runtime = f.build();
        await runtime.start(await createdSession(f, runtime));
        await damage(f.home, 'garbage', '{not json');
        await damage(f.home, 'claims-other', JSON.stringify({ version: 1, created: { sessionId: 'other-session' } }));
        await expect(f.journal.list()).rejects.toThrow();
        const entries = await f.journal.entries();
        expect(entries.flatMap(e => 'record' in e ? [e.record.created?.sessionId] : [])).toEqual(['session']);
        expect(entries.flatMap(e => 'error' in e ? [e.sessionId] : []).sort()).toEqual([null, 'other-session'].sort());
    });
});
describe('launch lineage beside a damaged journal file (PR #1027 review)', () => {
    async function startedOwned() {
        const f = await fixture(), hosts = hostCallers(), runtime = f.build({ launchCallers: hosts });
        f.onStart(async () => { hosts.callers.set('session', hostCaller({ sessionId: 'session' })); });
        expect(await runtime.start(await createdSession(f, runtime))).toMatchObject({ state: 'started' });
        return { f, runtime };
    }
    it('a damaged entry naming another session does not affect this launch', async () => {
        const { f, runtime } = await startedOwned();
        await damage(f.home, 'claims-other', JSON.stringify({ version: 1, created: { sessionId: 'other-session' } }));
        // An unrelated resume keeps its ordinary binding (no owned lineage); the owned session keeps its own.
        expect(await runtime.launchLineage('unrelated')).toBeNull();
        expect(await runtime.launchLineage('session')).toEqual({ sessionId: 'session', scope: '/project', depth: 0 });
    });
    it('this session\'s own damaged entry gives no binding', async () => {
        const { f, runtime } = await startedOwned();
        await damage(f.home, 'claims-resumed', JSON.stringify({ version: 1, created: { sessionId: 'resumed' } }));
        expect(await runtime.launchLineage('resumed')).toBe('unknown');
    });
    it('an entry that names no legible session may be this one, so it gives no binding', async () => {
        const { f, runtime } = await startedOwned();
        await damage(f.home, 'garbage', '{not json');
        expect(await runtime.launchLineage('unrelated')).toBe('unknown');
        // A readable record of this session still decides it.
        expect(await runtime.launchLineage('session')).toEqual({ sessionId: 'session', scope: '/project', depth: 0 });
    });
});
