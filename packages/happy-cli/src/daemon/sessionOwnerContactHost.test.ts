import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { closeSync, fstatSync, openSync, writeFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import nacl from 'tweetnacl';
import { ownerRelayV1Fixture as fixture, signOwnership, signOwnerRelayReply, verifyOwnerRelayRequest, type OwnershipRelayContact } from '@slopus/happy-wire';
import { createAgentCallerLaunches } from './agentCallerLaunches';
import { startHostOwnerContact, startSessionOwnerContactHost, takeOwnerContactCapability } from './sessionOwnerContactHost';
import type { TrackedSession } from './types';
import { startSessionAgentBroker } from '@/commands/sessionAgentBroker';

const request = { v: 1, entry: 'agent', operation: 'lookup-readable-sessions', payload: { sessionIds: ['target'] } } as const;
const chatRead = { v: 1, entry: 'chat', operation: 'read-session', targetSessionId: 'sibling', payload: { cursor: null, limit: 1, waitMs: 0 } } as const;
const childStatus = { v: 1, entry: 'chat', operation: 'owned-child-status', payload: { operationId: 'operation', spawnId: 'spawn', spawnDigest: 'a'.repeat(64) } } as const;
/** What a provider-run `saycode chat -s` does: POST a local DTO to the owner-only socket. */
function post(socketPath: string, body: unknown) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ socketPath, path: '/owner-contact-v1', method: 'POST', agent: false }, res => {
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}
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
    let identity: { machineId: string; happyAccountId: string; epoch: string } | null = { machineId: 'machine', happyAccountId: 'account', epoch: 'e1' };
    const launches = createAgentCallerLaunches({ enabled: options.daemonEnabled ?? true,
        identity: async () => identity,
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
        (await launches.current({ sessionId: caller.sessionId, callerBindingId: caller.callerBindingId })).current;
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
        resume: (next: number) => { pid = next; }, stopSession: () => { sessionLive = false; }, exit: () => { alive = false; },
        setIdentity: (next: typeof identity) => { identity = next; } };
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
    it.each([
        ['identity loss', null],
        ['an account switch', { machineId: 'machine', happyAccountId: 'other-account', epoch: 'e1' }],
        ['a registration epoch change', { machineId: 'machine', happyAccountId: 'account', epoch: 'e2' }],
        ['a machine change', { machineId: 'other-machine', happyAccountId: 'account', epoch: 'e1' }],
    ] as const)('stops signing and sending after %s, and the binding stays revoked [H2-R-06]', async (_name, next) => {
        const h = harness();
        const host = (await h.start())!;
        h.register(host.binding);
        h.setIdentity(next);
        await expect(host.contact.call(request)).rejects.toThrow();
        expect(h.sends).toEqual([]);
        h.setIdentity({ machineId: 'machine', happyAccountId: 'account', epoch: 'e1' });
        await expect(host.contact.call(request)).rejects.toThrow();
        expect(h.sends).toEqual([]);
    });
    it('discards the reply when the identity changes during the exchange [H2-R-06]', async () => {
        const h = harness();
        const host = (await h.start())!;
        h.register(host.binding);
        const send = h.session.callOwnerRelay.getMockImplementation()!;
        h.session.callOwnerRelay.mockImplementationOnce(async (method, relay) => {
            h.setIdentity({ machineId: 'machine', happyAccountId: 'other-account', epoch: 'e1' }); return send(method, relay);
        });
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
    it.each([
        ['no launch capability', { capability: null }],
        ['a managed session', { managed: true }],
        ['the switch off', { switchOn: false }],
    ] as const)('drops an inherited contact address before the broker starts with %s [H2-R-05]', async (_name, options) => {
        const h = harness(), w = wiring(h, { ...options, broker: true });
        if ('capability' in options) w.capability.mockResolvedValue(null);
        w.env.SAYCODE_OWNER_CONTACT_SOCKET = '/parent/contact.sock';
        const seen: Array<string | undefined> = [];
        w.startBroker.mockImplementation(async contact => { seen.push(w.env.SAYCODE_OWNER_CONTACT_SOCKET); return { contact }; });
        const started = await w.start();
        expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toBeUndefined();
        expect(seen).toEqual([undefined]);
        expect(w.startBroker).toHaveBeenCalledWith(undefined);
        await started.close();
    });
    it.skipIf(process.platform === 'win32')('hands the contact to the broker and opens a socket for the provider\'s chat only [D2pre-C]', async () => {
        const h = harness(), w = wiring(h, { broker: true });
        w.env.SAYCODE_OWNER_CONTACT_SOCKET = '/parent/contact.sock';
        const started = await w.start();
        const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<{ result: string }> };
        expect(contact).toBeDefined();
        const socket = w.env.SAYCODE_OWNER_CONTACT_SOCKET!;
        expect(socket).toEqual(expect.any(String));
        expect(socket).not.toBe('/parent/contact.sock');
        const binding = (await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller;
        h.register(binding);
        expect((await contact.call(request)).result).toBe('allowed');
        const chat = await post(socket, { ...request, entry: 'chat' });
        expect(chat.status).toBe(200); expect(JSON.parse(chat.body).result).toBe('allowed');
        const lookups = h.lookups.length;
        // Agent commands keep the broker IPC and its depth policy; owned children stay a broker reservation.
        expect((await post(socket, request)).status).toBe(503);
        expect((await post(socket, childStatus)).status).toBe(503);
        expect(h.lookups).toHaveLength(lookups);
        await started.close();
        expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toBeUndefined();
        await expect(post(socket, { ...request, entry: 'chat' })).rejects.toThrow();
        await expect(contact.call(request)).rejects.toThrow();
    });
    it.skipIf(process.platform === 'win32')('marks the broker-run CLI for owner IPC although the socket env comes after the broker [D2-R4-01]', async () => {
        const h = harness(), w = wiring(h);
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-broker-'))), entrypoint = join(root, 'cli.mjs');
        writeFileSync(entrypoint, `console.log(JSON.stringify({exitCode:0,stdout:JSON.stringify({ok:true,mark:process.env.SAYCODE_OWNER_CONTACT_BROKER_IPC ?? null,socket:process.env.SAYCODE_OWNER_CONTACT_SOCKET ?? null})}))`);
        Object.assign(w.env, { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: root });
        w.startBroker.mockImplementation(contact => startSessionAgentBroker('source', w.env, undefined, entrypoint, undefined, undefined, contact as never) as never);
        const started = await w.start();
        try {
            expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toEqual(expect.any(String));
            const response = await fetch(w.env.SAYCODE_AGENT_BROKER_URL!, { method: 'POST', headers: { authorization: `Bearer ${w.env.SAYCODE_AGENT_BROKER_CAPABILITY}` },
                body: JSON.stringify({ version: 1, argv: ['whoami'] }) });
            expect(JSON.parse((await response.json() as { stdout: string }).stdout)).toEqual({ ok: true, mark: '1', socket: null });
        } finally {
            await (started.broker as { close(): Promise<void> } | null)?.close();
            await started.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('a chat socket that cannot start leaves the broker binding usable [D2pre-C]', async () => {
        const h = harness(), w = wiring(h, { broker: true });
        const previous = process.env.TMPDIR;
        // Too long for a Unix socket path: the socket fails after taking the contact it was given.
        const long = join(mkdtempSync(join(tmpdir(), 'oc-long-')), 'x'.repeat(100));
        mkdirSync(long);
        process.env.TMPDIR = long;
        let started!: Awaited<ReturnType<typeof w.start>>;
        try { started = await w.start(); } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(long, { recursive: true, force: true }); }
        expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toBeUndefined();
        const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<{ result: string }> };
        h.register((await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller);
        expect((await contact.call(request)).result).toBe('allowed');
        await started.close();
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
        const started = await w.start();
        try {
            const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<{ result: string }> };
            h.register({ ...(await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller, depth: 1 });
            await expect(contact.call(sibling)).rejects.toThrow();
            expect(h.lookups).toEqual([]);
        } finally { await started.close(); }
    });
    it.skipIf(process.platform === 'win32')('below depth 0 a broker host refuses chat lookup but leaves explicit chat targets to main [D2pre-C]', async () => {
        const h = harness({ depth: '1' }), w = wiring(h, { broker: true });
        const started = await w.start();
        const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<unknown> };
        h.register({ ...(await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller, depth: 1 });
        const socket = w.env.SAYCODE_OWNER_CONTACT_SOCKET!;
        // Sibling non-exposure below depth 0 (P0a §2.3) also holds for chat enumeration, over either entry point.
        await expect(contact.call({ ...request, entry: 'chat' })).rejects.toThrow();
        expect((await post(socket, { ...request, entry: 'chat' })).status).toBe(503);
        expect(h.lookups).toEqual([]);
        // An explicit target is main's decision (own at every depth, self refused there): it reaches the lookup.
        await post(socket, chatRead);
        const viaSocket = h.lookups.length;
        expect(viaSocket).toBeGreaterThan(0);
        await contact.call(chatRead).catch(() => undefined);
        expect(h.lookups.length).toBeGreaterThan(viaSocket);
        await started.close();
    });
    it('lets a depth >= 1 broker agent reach its own owned-child operations [H2-R-04]', async () => {
        const h = harness({ depth: '1' }), w = wiring(h, { broker: true });
        const started = await w.start();
        try {
            const contact = (w.startBroker.mock.calls[0] as unknown[])[0] as { call(raw: unknown): Promise<unknown> };
            h.register({ ...(await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller, depth: 1 });
            const child = { operationId: 'operation', spawnId: 'spawn', spawnDigest: 'a'.repeat(64) };
            await contact.call({ v: 1, entry: 'agent', operation: 'owned-child-status', payload: child }).catch(() => undefined);
            // Past the broker policy: the contact was looked up for this source (the fake main then answers).
            expect(h.lookups.length).toBeGreaterThan(0);
        } finally { await started.close(); }
    });
    it.skipIf(process.platform === 'win32')('keeps direct agent commands at every depth', async () => {
        const h = harness({ depth: '3' }), w = wiring(h);
        const started = await w.start();
        expect(w.env.SAYCODE_OWNER_CONTACT_SOCKET).toBeDefined();
        await started.close();
    });
    it.skipIf(process.platform === 'win32')('keeps the direct socket open to agent and chat lookup at every depth [D2pre-C]', async () => {
        const h = harness({ depth: '3' }), w = wiring(h);
        const started = await w.start();
        h.register({ ...(await h.launches.query({ sessionId: 'source', nonce: 'n'.repeat(32) })).caller, depth: 3 });
        const socket = w.env.SAYCODE_OWNER_CONTACT_SOCKET!;
        for (const entry of ['agent', 'chat']) expect(JSON.parse((await post(socket, { ...request, entry })).body).result).toBe('allowed');
        await started.close();
    });
    it('starts without owner contact when the daemon refuses', async () => {
        const h = harness({ daemonEnabled: false }), w = wiring(h, { broker: true });
        const started = await w.start();
        expect(w.startBroker).toHaveBeenCalledWith(undefined);
        expect(started.broker).toEqual({ contact: undefined });
        await started.close();
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
