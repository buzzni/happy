import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { signOwnership, ownershipDigest, sessionCreateBodyHash, sessionTagHash, rotationSha256 } from '@slopus/happy-wire';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from './types';
import { createOwnedSpawnRuntime } from './ownedSpawnRuntime';
import { registerOwnedSpawnRpc } from './ownedSpawnRpc';
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'owned-runtime-')); homes.push(home);
    const keys = nacl.sign.keyPair(), now = Date.now();
    const signed = { version: 1, issuer: 'https://studio.test', audience: 'https://happy.test', keyId: await rotationSha256(keys.publicKey), issuedAt: now, expiresAt: now + 60_000 };
    const spawn = { directory: '/project', agent: 'codex' };
    const scope = { intentId: 'intent', operationId: 'operation', creationRequestId: 'creation', ownershipPolicy: 'prefer-owned', subject: { issuer: signed.issuer, userId: 'person' },
        companyId: null, projectId: null, machineId: 'machine', machineAccountId: 'account', sessionAccountId: 'account', parentHubSessionId: null, spawnDigest: await ownershipDigest(spawn) };
    const intent = signOwnership({ ...signed, ...scope, type: 'saycode-session-ownership-intent' }, keys.secretKey);
    let raw: Record<string, unknown> | null = null, tracked: TrackedSession | undefined;
    let posts = 0, starts = 0, lose = false, current = true;
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url).endsWith('/v1/account/profile')) return Response.json({ id: 'account' });
        if (String(url).includes('/v2/sessions')) return Response.json({ sessions: raw ? [raw] : [], hasNext: false, nextCursor: null });
        expect(String(url)).toBe('https://happy.test/v1/sessions'); posts++;
        const body = JSON.parse(String(options?.body));
        raw = { id: 'session', seq: 0, metadataVersion: 1, agentStateVersion: 1, metadata: body.metadata, agentState: body.agentState, dataEncryptionKey: body.dataEncryptionKey };
        if (lose) throw new Error('lost ACK');
        const { ownershipProof: _proof, ...create } = body;
        return Response.json({ session: raw, ownership: { sessionId: 'session', ownershipBindingId: 'binding', registrationState: 'pending', createDigest: await sessionCreateBodyHash(create) } });
    }) as typeof fetch;
    const persist = vi.fn(async () => ({ status: 'committed' as const }));
    const build = () => createOwnedSpawnRuntime({ home, happyOrigin: signed.audience, env: { HAPPY_SESSION_OWNERSHIP_ENABLED: '1', HAPPY_SESSION_OWNERSHIP_ISSUER: signed.issuer,
        HAPPY_SESSION_OWNERSHIP_AUDIENCE: signed.audience, HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: JSON.stringify({ [signed.keyId]: Buffer.from(keys.publicKey).toString('base64url') }) },
        registration: async () => { if (!current) throw new Error('identity-changed'); return { machineId: 'machine', epoch: 'registration', credentials: { token: 'synthetic-machine-bearer', encryption: { type: 'legacy', secret: new Uint8Array(32) } } }; },
        metadata: () => ({ path: '/project', host: 'box', machineId: 'machine', flavor: 'codex' }) as Metadata,
        rotation: async () => null, fetch: fetcher, persist,
        tracked: () => tracked, live: s => s.pid > 0,
        start: async options => {
            starts++; expect(options.reconnectEnvironment?.HAPPY_RECONNECT_SESSION_ID).toBe('session');
            expect(JSON.stringify(options)).not.toContain('signature'); expect(JSON.stringify(options)).not.toContain('synthetic-machine-bearer');
            tracked = { pid: 123, happySessionId: 'session', startedBy: 'daemon', directory: '/project' };
            return { type: 'success', sessionId: 'session' };
        },
    });
    return { spawn, intent, build, persist, counts: () => ({ posts, starts }), lose: () => { lose = true }, logout: () => { current = false },
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
