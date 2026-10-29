import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { closeSync, fstatSync, openSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import nacl from 'tweetnacl';
import { ownerRelayV1Fixture as fixture, signOwnership, signOwnerRelayReply, verifyOwnerRelayRequest, type OwnershipRelayContact } from '@slopus/happy-wire';
import { createAgentCallerLaunches } from './agentCallerLaunches';
import { startHostOwnerContact, startSessionOwnerContactHost, takeOwnerContactCapability } from './sessionOwnerContactHost';
import type { TrackedSession } from './types';

const request = { v: 1, entry: 'agent', operation: 'lookup-readable-sessions', payload: { sessionIds: ['target'] } } as const;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
/** The daemon spawn path: returns the capability the host would read from its private pipe. */
async function launchCapability(launches: ReturnType<typeof createAgentCallerLaunches>, pid: number) {
    const prepared = launches.prepareLaunch({ cwd: '/project' });
    if (!prepared) return null;
    const { environment } = prepared.stdio(['ignore', 'ignore', 'ignore']);
    const pipe = new PassThrough(), chunks: Buffer[] = [];
    pipe.on('data', chunk => chunks.push(chunk));
    const child = { pid, stdio: Object.assign([], { [Number(environment.HAPPY_OWNER_CONTACT_FD)]: pipe }), once: () => child } as unknown as ChildProcess;
    prepared.attach(child);
    await new Promise(resolve => pipe.once('finish', resolve));
    return JSON.parse(Buffer.concat(chunks).toString()).capability as string;
}
function harness(options: { enabled?: boolean; daemonEnabled?: boolean; depth?: string } = {}) {
    const server = nacl.sign.keyPair(), desktop = nacl.sign.keyPair();
    const now = Date.now();
    let pid = 42, alive = true, sessionLive = true;
    const issued: unknown[] = [], lookups: Array<{ url: string; body: unknown; auth: string | null }> = [], sends: unknown[] = [];
    let contact: OwnershipRelayContact | null = null;
    const launches = createAgentCallerLaunches({ enabled: options.daemonEnabled ?? true,
        identity: async () => ({ machineId: 'machine', happyAccountId: 'account', epoch: 'e1' }),
        trust: () => ({ issuer: fixture.contact.issuer, audience: fixture.contact.audience,
            publicKeys: { [fixture.contact.keyId]: b64(server.publicKey) }, lookupOrigin: 'https://studio.example' }),
        trackedByPid: hostPid => hostPid === pid ? { startedBy: 'daemon', pid, directory: '/project', happySessionId: 'source' } as TrackedSession : undefined,
        live: () => alive, realpath: path => path });
    // Depth >= 1 reaches a host only from an owned lineage the daemon recorded (H3); simulate that daemon reply.
    const issue = async (report: unknown) => {
        const reply = await launches.issue(report);
        return options.depth ? { ...reply, caller: { ...reply.caller, depth: Number(options.depth) } } : reply;
    };
    const current = async (caller: { sessionId: string; callerBindingId: string }) =>
        launches.current({ sessionId: caller.sessionId, callerBindingId: caller.callerBindingId }).current;
    const register = (caller: { callerBindingId: string; runtimeId: string; hostEpoch: string; callerPublicKey: string; scope: string; depth: number }) => {
        contact = signOwnership({ ...fixture.contact, hubId: 'source', sourceRuntimeId: caller.runtimeId, callerBindingId: caller.callerBindingId,
            hostEpoch: caller.hostEpoch, callerPublicKey: caller.callerPublicKey, machineId: 'machine', happyAccountId: 'account',
            scope: caller.scope, depth: caller.depth, publicKey: b64(desktop.publicKey), issuedAt: now, expiresAt: now + 60000 }, server.secretKey) as OwnershipRelayContact;
    };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        lookups.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify({ contacts: contact ? [contact] : [] }), { status: 200 });
    });
    const session = { sessionId: 'source', runtimeId: 'actual-runtime',
        callOwnerRelay: vi.fn(async (method: string, relay: Record<string, unknown>) => {
            sends.push({ method, relay });
            const { entry, payload, callerSignature, ...bound } = relay as never as Record<string, unknown>;
            void entry; void payload; void callerSignature;
            return signOwnerRelayReply({ ...bound, responderSubject: contact!.ownerSubject, checkedAt: now, result: 'allowed', owners: [] }, desktop.secretKey);
        }) };
    const start = async () => startSessionOwnerContactHost({ enabled: options.enabled ?? true, session, hostPid: pid, live: () => sessionLive,
        capability: await launchCapability(launches, pid) ?? '', current,
        issue: async report => { issued.push(report); return issue(report); }, token: async () => 'happy-token', fetch: fetcher, now: () => now });
    return { start, launches, issue, current, register, issued, lookups, sends, session, fetcher, contact: () => contact!, pid: () => pid,
        resume: (next: number) => { pid = next; }, stopSession: () => { sessionLive = false; }, exit: () => { alive = false; } };
}
describe('host owner-contact bootstrap', () => {
    it('is default off: no key, daemon report, lookup or env change', async () => {
        const h = harness({ enabled: false });
        const before = { ...process.env };
        expect(await h.start()).toBeNull();
        expect(h.issued).toEqual([]); expect(h.fetcher).not.toHaveBeenCalled();
        expect(process.env).toEqual(before);
    });
    it('binds the actual created session runtime and relays a verified request', async () => {
        const h = harness();
        const host = (await h.start())!;
        expect(host.binding).toMatchObject({ sessionId: 'source', runtimeId: 'actual-runtime', scope: '/project', depth: 0 });
        expect(h.issued).toEqual([{ sessionId: 'source', runtimeId: 'actual-runtime', hostPid: 42, callerPublicKey: host.binding.callerPublicKey,
            capability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }]);
        expect((await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller).toEqual(host.binding);
        h.register(host.binding);
        expect((await host.contact.call(request)).result).toBe('allowed');
        expect(h.lookups[0]).toEqual({ url: 'https://studio.example/api/v2/session-ownership/source/relays/lookup',
            body: { machineId: 'machine', callerBindingId: host.binding.callerBindingId, hostEpoch: host.binding.hostEpoch }, auth: 'Bearer happy-token' });
        const sent = h.sends[0] as { method: string; relay: unknown };
        expect(sent.method).toBe(h.contact().method);
        expect(await verifyOwnerRelayRequest(sent.relay, h.contact(), Date.now())).toBe(true);
    });
    it('never exposes the signing key or bearer to the result, report or environment', async () => {
        const h = harness();
        const host = (await h.start())!;
        h.register(host.binding);
        await host.contact.call(request);
        const visible = JSON.stringify({ host, issued: h.issued, sends: h.sends, env: process.env });
        expect(visible).not.toContain('happy-token');
        expect(visible).not.toMatch(/secretKey/);
        expect(Object.keys(process.env).filter(key => /OWNER_CONTACT|CALLER/.test(key))).toEqual([]);
    });
    it('a resumed host gets a new binding and the old host can no longer sign', async () => {
        const h = harness();
        const old = (await h.start())!;
        h.resume(77);
        const resumed = (await h.start())!;
        expect(resumed.binding.callerBindingId).not.toBe(old.binding.callerBindingId);
        expect((await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller).toEqual(resumed.binding);
        // Main registers contacts only for the binding the daemon currently vouches for.
        h.register(resumed.binding);
        await expect(old.contact.call(request)).rejects.toThrow();
        expect(h.sends).toEqual([]);
        expect((await resumed.contact.call(request)).result).toBe('allowed');
    });
    it('an old host cannot sign or send once the daemon replaced its binding, even with its unexpired contact [H2-R-03]', async () => {
        const h = harness();
        const old = (await h.start())!;
        h.register(old.binding);
        h.resume(77);
        await h.start();
        await expect(old.contact.call(request)).rejects.toThrow();
        expect(h.sends).toEqual([]);
    });
    it('discards the reply when the daemon replaces the binding during the exchange [H2-R-03]', async () => {
        const h = harness();
        const host = (await h.start())!;
        h.register(host.binding);
        const send = h.session.callOwnerRelay.getMockImplementation()!;
        h.session.callOwnerRelay.mockImplementationOnce(async (method, relay) => { h.resume(77); await h.start(); return send(method, relay); });
        await expect(host.contact.call(request)).rejects.toThrow();
        expect(h.sends).toHaveLength(1);
    });
    it('rejects a stale binding after the session runtime stops', async () => {
        const h = harness();
        const host = (await h.start())!;
        h.register(host.binding); h.stopSession();
        await expect(host.contact.call(request)).rejects.toThrow();
        expect(h.sends).toEqual([]);
    });
    it('rejects a contact that fails verification before transport', async () => {
        const h = harness();
        const host = (await h.start())!;
        h.register({ ...host.binding, callerBindingId: 'other-binding' });
        await expect(host.contact.call(request)).rejects.toThrow();
        expect(h.sends).toEqual([]);
    });
    it('limits lookup to its own source, machine and binding regardless of the local request', async () => {
        const h = harness();
        const host = (await h.start())!;
        h.register(host.binding);
        await expect(host.contact.call({ ...request, sourceHubSessionId: 'other' })).rejects.toThrow();
        await host.contact.call({ ...request, payload: { sessionIds: ['other-a', 'other-b'] } });
        expect(h.lookups.map(l => l.url)).toEqual(Array(h.lookups.length).fill('https://studio.example/api/v2/session-ownership/source/relays/lookup'));
    });
    it.each([
        ['the daemon refuses', { daemonEnabled: false }],
    ] as const)('starts nothing when %s', async (_name, options) => {
        const h = harness(options);
        expect(await h.start()).toBeNull();
        expect(h.fetcher).not.toHaveBeenCalled();
    });
    it('refuses a daemon reply bound to another runtime or key', async () => {
        const h = harness();
        const host = await startSessionOwnerContactHost({ enabled: true, session: h.session, hostPid: 42, live: () => true,
            capability: (await launchCapability(h.launches, 42))!, current: h.current,
            issue: async report => { const issued = await h.launches.issue(report); return { ...issued, caller: { ...issued.caller, runtimeId: 'other' } }; },
            token: async () => 'happy-token', fetch: h.fetcher });
        expect(host).toBeNull();
    });
});
describe('host owner-contact wiring (startHappyServer)', () => {
    const wiring = (h: ReturnType<typeof harness>, options: { switchOn?: boolean; managed?: boolean; broker?: boolean } = {}) => {
        const env: NodeJS.ProcessEnv = options.switchOn === false ? {} : { HAPPY_OWNER_CONTACT_V1: '1' };
        const startBroker = vi.fn(async (contact: unknown) => options.broker ? { contact } : null);
        const session = { ...h.session, getManagedOrigin: () => options.managed ? 'https://managed.example' : null };
        const capability = vi.fn(async () => launchCapability(h.launches, h.pid()));
        return { env, startBroker, capability, start: () => startHostOwnerContact({ env, session, hostPid: 42, capability, current: h.current,
            issue: async report => { h.issued.push(report); return h.issue(report); }, token: async () => 'happy-token', fetch: h.fetcher, startBroker }) };
    };
    it.each([['the switch is off', { switchOn: false }], ['the session is managed', { managed: true }]] as const)('keeps the existing broker launch when %s', async (_name, options) => {
        const h = harness(), w = wiring(h, { ...options, broker: true });
        const before = { ...w.env };
        const started = await w.start();
        // A capability the daemon passed is still consumed so it never outlives the host's startup.
        expect(w.capability).toHaveBeenCalledOnce();
        expect(w.startBroker).toHaveBeenCalledWith(undefined);
        expect(started.broker).toEqual({ contact: undefined });
        expect(h.issued).toEqual([]); expect(w.env).toEqual(before);
        await started.close(); expect(w.env).toEqual(before);
    });
    it('hands the contact to the broker without opening a local socket', async () => {
        const h = harness(), w = wiring(h, { broker: true });
        w.env.SAYCODE_OWNER_CONTACT_SOCKET = '/parent/contact.sock';
        const started = await w.start();
        const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<{ result: string }> };
        expect(contact).toBeDefined();
        expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toBeUndefined();
        const binding = (await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller;
        h.register(binding);
        expect((await contact.call(request)).result).toBe('allowed');
        await started.close();
        await expect(contact.call(request)).rejects.toThrow();
    });
    it.skipIf(process.platform === 'win32')('gives a direct runtime only the local socket address and removes it on close', async () => {
        const h = harness(), w = wiring(h);
        const started = await w.start();
        expect(w.startBroker).toHaveBeenCalledOnce();
        expect(Object.keys(w.env).sort()).toEqual(['HAPPY_OWNER_CONTACT_V1', 'SAYCODE_OWNER_CONTACT_SOCKET']);
        expect(JSON.stringify(w.env)).not.toContain('happy-token');
        await started.close();
        expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toBeUndefined();
    });
    it.each([
        ['lookup-readable-sessions', request],
        ['read-session', { v: 1, entry: 'agent', operation: 'read-session', targetSessionId: 'sibling', payload: { cursor: null, limit: 1, waitMs: 0 } }],
        ['abort-own-turn', { v: 1, entry: 'agent', operation: 'abort-own-turn', targetSessionId: 'sibling', payload: { sessionId: 'sibling', runtimeId: 'r' } }],
    ] as const)('refuses broker sibling/parent %s for an agent command at depth >= 1 (P0a §2.3)', async (_name, sibling) => {
        const h = harness({ depth: '1' }), w = wiring(h, { broker: true });
        await w.start();
        const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<{ result: string }> };
        h.register({ ...(await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller, depth: 1 });
        await expect(contact.call(sibling)).rejects.toThrow();
        expect(h.lookups).toEqual([]);
        expect((await contact.call({ ...request, entry: 'chat' })).result).toBe('allowed');
    });
    it('lets a depth >= 1 broker agent reach its own owned-child operations [H2-R-04]', async () => {
        const h = harness({ depth: '1' }), w = wiring(h, { broker: true });
        await w.start();
        const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<unknown> };
        h.register({ ...(await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller, depth: 1 });
        const child = { operationId: 'operation', spawnId: 'spawn', spawnDigest: 'a'.repeat(64) };
        await contact.call({ v: 1, entry: 'agent', operation: 'owned-child-status', payload: child }).catch(() => undefined);
        // Past the broker policy: the contact was looked up for this source (the fake main then answers).
        expect(h.lookups.length).toBeGreaterThan(0);
    });
    it.skipIf(process.platform === 'win32')('keeps direct agent commands at every depth', async () => {
        const h = harness({ depth: '3' }), w = wiring(h);
        const started = await w.start();
        expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toBeDefined();
        await started.close();
    });
    it('starts without owner contact when the daemon refuses', async () => {
        const h = harness({ daemonEnabled: false }), w = wiring(h, { broker: true });
        const started = await w.start();
        expect(w.startBroker).toHaveBeenCalledWith(undefined);
        expect(started.broker).toEqual({ contact: undefined });
    });
});
describe('launch capability pipe (host side) [H2-R-01]', () => {
    it('reads the capability once, removes the descriptor variable and closes the descriptor', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'oc-cap-')), 'pipe');
        writeFileSync(path, JSON.stringify({ capability: 'c'.repeat(43) }));
        const fd = openSync(path, 'r'), env: NodeJS.ProcessEnv = { HAPPY_OWNER_CONTACT_FD: String(fd) };
        expect(await takeOwnerContactCapability(env)).toBe('c'.repeat(43));
        expect(env).toEqual({});
        expect(() => fstatSync(fd)).toThrow();
        expect(await takeOwnerContactCapability(env)).toBeNull();
    });
    it.each([['no descriptor', {}], ['a std descriptor', { HAPPY_OWNER_CONTACT_FD: '2' }], ['a malformed value', { HAPPY_OWNER_CONTACT_FD: 'x' }]])('yields nothing for %s', async (_name, env) => {
        expect(await takeOwnerContactCapability({ ...env })).toBeNull();
    });
    it('rejects malformed pipe content', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'oc-cap-')), 'pipe');
        writeFileSync(path, '{"capability":"short"}');
        const fd = openSync(path, 'r');
        expect(await takeOwnerContactCapability({ HAPPY_OWNER_CONTACT_FD: String(fd) })).toBeNull();
        expect(() => closeSync(fd)).toThrow();
    });
});
