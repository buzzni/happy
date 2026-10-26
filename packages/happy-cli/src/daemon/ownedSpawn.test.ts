/** T4rt durable operation boundaries, including daemon restart and uncertain side effects. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ownershipDigest, sessionCreateBodyHash, sessionTagHash } from '@slopus/happy-wire';
import { createOwnedSpawnJournal } from './ownedSpawnJournal';
import { createOwnedSpawn, type OwnedSpawnDependencies } from './ownedSpawn';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const now = Date.now();
const signed = { version: 1, issuer: 'https://studio.test', audience: 'https://happy.test', keyId: 'a'.repeat(64),
    issuedAt: now, expiresAt: now + 60_000, signature: Buffer.alloc(64).toString('base64url') };
async function fixture(policy: 'prefer-owned' | 'require-owned' = 'prefer-owned') {
    const home = await mkdtemp(join(tmpdir(), 'owned-spawn-')); homes.push(home);
    const journal = createOwnedSpawnJournal(home);
    const spawn = { directory: '/project', agent: 'codex' as const };
    const intent = { ...signed, type: 'saycode-session-ownership-intent', intentId: 'intent', operationId: 'operation',
        creationRequestId: 'creation', ownershipPolicy: policy, subject: { issuer: signed.issuer, userId: 'person' },
        companyId: 'company', projectId: 'project', machineId: 'machine', machineAccountId: 'account', sessionAccountId: 'account',
        parentHubSessionId: null, spawnDigest: await ownershipDigest(spawn) };
    const body = { tag: 'tag', metadata: 'ciphertext', agentState: null, dataEncryptionKey: null };
    let prepares = 0, commits = 0, starts = 0, created = false, running = false, loseCommit = false, loseStart = false;
    const deps: OwnedSpawnDependencies = { journal, now: () => now,
        verify: async () => true, scope: async () => ({ machineId: 'machine', machineAccountId: 'account', sessionAccountId: 'account' }),
        prepare: async () => { prepares++; return { body, encryptionKey: Buffer.alloc(32).toString('base64'), encryptionVariant: 'legacy' }; },
        commit: async () => { commits++; created = true; if (loseCommit) throw new Error('lost ack'); return { sessionId: 'session', ownershipBindingId: 'binding', registrationState: 'pending', createDigest: await sessionCreateBodyHash(body) }; },
        discover: async record => created ? { sessionId: 'session', ...(record.creationMode === 'signed' ? { ownershipBindingId: 'binding', registrationState: 'pending' as const } : {}), createDigest: await sessionCreateBodyHash(body) } : null,
        start: async () => { starts++; running = true; if (loseStart) throw new Error('lost start ack'); return { providerRuntimeId: 'runtime' }; },
        observeStart: async () => running ? { providerRuntimeId: 'runtime' } : null,
        caller: async () => ({ callerBindingId: 'caller', sessionId: 'session', runtimeId: 'runtime', machineId: 'machine', happyAccountId: 'account',
            scope: '/project', depth: 0, hostEpoch: 'host', callerPublicKey: Buffer.alloc(32).toString('base64url') }),
    };
    const proof = { ...intent, type: 'saycode-session-ownership', nonce: Buffer.alloc(32, 1).toString('base64url'),
        tagHash: await sessionTagHash(body.tag), createBodyHash: await sessionCreateBodyHash(body) };
    const runtime = () => createOwnedSpawn(deps);
    return { runtime, deps, intent, spawn, proof, journal, body,
        counts: () => ({ prepares, commits, starts }), loseCommit: () => { loseCommit = true }, loseStart: () => { loseStart = true },
        async prepare(r = runtime()) { return r.prepare({ intent, spawn }); },
    };
}
it('prepares once, rejects changed options, and recovers the same snapshot after restart', async () => {
    const f = await fixture(); const first = await f.prepare();
    expect(await f.prepare(f.runtime())).toEqual(first);
    expect(f.counts().prepares).toBe(1);
    await expect(f.runtime().prepare({ intent: f.intent, spawn: { ...f.spawn, directory: '/other' } })).rejects.toThrow();
});
it('serializes duplicate commit/start and returns the same durable receipt on restart', async () => {
    const f = await fixture(); const r = f.runtime(); const prepared = await f.prepare(r);
    const command = { creationRequestId: 'creation', preparationId: prepared.preparationId, ownershipProof: f.proof };
    const [a, b] = await Promise.all([r.commit(command), r.commit(command)]);
    expect(a).toEqual(b); expect(f.counts().commits).toBe(1);
    const start = { creationRequestId: 'creation', preparationId: prepared.preparationId, sessionId: 'session' };
    const result = await r.start(start);
    expect(result).toMatchObject({ state: 'started', ownershipOutcome: 'pending', sessionId: 'session' });
    expect(await f.runtime().start(start)).toEqual(result); expect(f.counts().starts).toBe(1);
});
it('recovers a lost create ACK through status without another POST', async () => {
    const f = await fixture(); const r = f.runtime(); const p = await f.prepare(r); f.loseCommit();
    await r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof });
    expect(await f.runtime().status({ creationRequestId: 'creation' })).toMatchObject({ state: 'created', sessionId: 'session' });
    expect(f.counts().commits).toBe(1);
});
it('recovers a lost start ACK without launching the provider again', async () => {
    const f = await fixture(); const r = f.runtime(); const p = await f.prepare(r);
    await r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof }); f.loseStart();
    await r.start({ creationRequestId: 'creation', preparationId: p.preparationId, sessionId: 'session' });
    expect(await f.runtime().status({ creationRequestId: 'creation' })).toMatchObject({ state: 'started', providerRuntimeId: 'runtime' });
    expect(f.counts().starts).toBe(1);
});
it('allows explicit prefer-owned downgrade before POST and rejects late seal or policy mutation', async () => {
    const f = await fixture(); const r = f.runtime(); const p = await f.prepare(r);
    await r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, unprovenReason: 'ownership-timeout' });
    await expect(r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof })).rejects.toThrow();
    await expect(r.prepare({ intent: { ...f.intent, ownershipPolicy: 'require-owned' }, spawn: f.spawn })).rejects.toThrow();
    expect(f.counts().commits).toBe(1);
});
it('require-owned never starts pending or downgrades unsigned', async () => {
    const f = await fixture('require-owned'); const r = f.runtime(); const p = await f.prepare(r);
    await expect(r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, unprovenReason: 'ownership-timeout' })).rejects.toThrow();
    await r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof });
    await expect(r.start({ creationRequestId: 'creation', preparationId: p.preparationId, sessionId: 'session' })).rejects.toThrow();
    expect(f.counts().starts).toBe(0);
});
it('rejects wrong subject/body, expired authority, and wrong session before side effects', async () => {
    const f = await fixture(); const r = f.runtime(); const p = await f.prepare(r);
    for (const change of [{ subject: { ...f.intent.subject, userId: 'other' } }, { createBodyHash: 'c'.repeat(64) }, { expiresAt: now - 1 }]) {
        await expect(r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: { ...f.proof, ...change } })).rejects.toThrow();
    }
    expect(f.counts().commits).toBe(0);
});
it('confirms the same pending session after provider start without another launch', async () => {
    const f = await fixture(), r = f.runtime(), p = await f.prepare(r);
    await r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof });
    const start = { creationRequestId: 'creation', preparationId: p.preparationId, sessionId: 'session' };
    await r.start(start);
    const confirmedReceipt = { ...signed, type: 'saycode-session-ownership-receipt', requestId: 'creation', operationId: 'operation', creationRequestId: 'creation',
        ownershipPolicy: 'prefer-owned', preparationId: p.preparationId, sessionId: 'session', bindingId: 'binding', subject: f.intent.subject,
        createDigest: await sessionCreateBodyHash(f.body), parentHubSessionId: null, spawnDigest: f.intent.spawnDigest, state: 'confirmed' };
    expect(await f.runtime().start({ ...start, confirmedReceipt })).toMatchObject({ state: 'started', ownershipOutcome: 'confirmed', registrationState: 'confirmed' });
    expect(f.counts()).toEqual({ prepares: 1, commits: 1, starts: 1 });
});
it('journal publication failures cannot issue create or provider start', async () => {
    const f = await fixture(), r = f.runtime(), p = await f.prepare(r);
    f.deps.journal.write = async () => { throw new Error('disk unavailable') };
    await expect(r.commit({ creationRequestId: 'creation', preparationId: p.preparationId, ownershipProof: f.proof })).rejects.toThrow();
    expect(f.counts()).toEqual({ prepares: 1, commits: 0, starts: 0 });
});
