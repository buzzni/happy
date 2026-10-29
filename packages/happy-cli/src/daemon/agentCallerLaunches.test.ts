import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import nacl from 'tweetnacl';
import { createAgentCallerLaunches, readOwnerContactTrust } from './agentCallerLaunches';
import type { TrackedSession } from './types';

const key = () => Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url');
const trust = { issuer: 'https://studio.example', audience: 'https://happy.example', publicKeys: { k1: 'x'.repeat(43) }, lookupOrigin: 'https://studio.example' };
type Launches = ReturnType<typeof createAgentCallerLaunches>;
/** Spawns a fake host through the daemon launch path and returns the capability its private pipe received. */
async function spawnHost(launches: Launches, pid: number, input: { cwd?: string; agentEnvironment?: TrackedSession['agentEnvironment'] } = {}) {
    const prepared = launches.prepareLaunch({ cwd: input.cwd ?? '/project', agentEnvironment: input.agentEnvironment });
    if (!prepared) return { capability: undefined, environment: {} as Record<string, string>, stdio: undefined };
    const { stdio, environment } = prepared.stdio(['ignore', 7, 7]);
    const pipe = new PassThrough(), chunks: Buffer[] = [];
    pipe.on('data', chunk => chunks.push(chunk));
    const child = { pid, stdio: Object.assign([], { [Number(environment.HAPPY_OWNER_CONTACT_FD)]: pipe }), once: () => child } as unknown as ChildProcess;
    prepared.attach(child);
    await new Promise(resolve => pipe.once('finish', resolve));
    return { capability: JSON.parse(Buffer.concat(chunks).toString()).capability as string, environment, stdio };
}
function harness(options: { enabled?: boolean; tracked?: Partial<TrackedSession> | null; agentEnvironment?: TrackedSession['agentEnvironment'] } = {}) {
    let identity: { machineId: string; happyAccountId: string; epoch: string } | null = { machineId: 'machine', happyAccountId: 'account', epoch: 'e1' };
    let alive = true;
    let session: TrackedSession | undefined = options.tracked === null ? undefined : { startedBy: 'daemon', pid: 42, directory: '/project',
        happySessionId: 'source', ...options.tracked } as TrackedSession;
    let identityFails = false;
    const build = () => createAgentCallerLaunches({ enabled: options.enabled ?? true,
        identity: async () => { if (identityFails) throw new Error('profile unavailable'); return identity; }, trust: () => trust,
        trackedByPid: pid => pid === session?.pid ? session : undefined, live: () => alive, realpath: path => path });
    let launches = build();
    let capabilities = new Map<number, string | undefined>();
    const spawn = async (pid = 42, agentEnvironment = options.agentEnvironment) => {
        const host = await spawnHost(launches, pid, { agentEnvironment }); capabilities.set(pid, host.capability); return host;
    };
    const report = (override: Record<string, unknown> = {}) => {
        const hostPid = (override.hostPid as number | undefined) ?? 42;
        return { sessionId: 'source', runtimeId: 'actual-runtime', hostPid, callerPublicKey: key(), capability: capabilities.get(hostPid) ?? 'c'.repeat(43), ...override };
    };
    return { get launches() { return launches; }, spawn, report, stop: () => { alive = false; }, resume: (pid: number) => { session = { ...session!, pid }; },
        restartDaemon: () => { launches = build(); capabilities = new Map(); },
        webhook: (id: string | undefined) => { session = { ...session!, happySessionId: id }; },
        switchAccount: () => { identity = { ...identity!, happyAccountId: 'other' }; }, forget: () => { identity = null; },
        changeEpoch: () => { identity = { ...identity!, epoch: 'e2' }; }, failIdentity: () => { identityFails = true; },
        restoreIdentity: () => { identity = { machineId: 'machine', happyAccountId: 'account', epoch: 'e1' }; } };
}
const nonce = 'n'.repeat(32);
describe('daemon launch caller bindings', () => {
    it('issues a top-level launch at depth 0 in the directory the daemon launched it', async () => {
        const h = harness(); await h.spawn();
        const report = h.report();
        const issued = await h.launches.issue(report);
        expect(issued.caller).toMatchObject({ sessionId: 'source', runtimeId: 'actual-runtime', machineId: 'machine', happyAccountId: 'account',
            scope: '/project', depth: 0, callerPublicKey: report.callerPublicKey });
        expect(issued.trust).toEqual(trust);
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(issued.caller);
    });
    it.each([
        ['scope widening', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/', SAYCODE_AGENT_SCOPE: '/', SAYCODE_AGENT_DEPTH: '2' }],
        ['depth lowering', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/project', SAYCODE_AGENT_DEPTH: '0' }],
        ['an agent grant without depth', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/project' }],
    ])('never derives scope or depth from a requested agent environment (%s) [H2-R-02]', async (_name, agentEnvironment) => {
        const h = harness({ tracked: { agentEnvironment }, agentEnvironment }); await h.spawn();
        await expect(h.launches.issue(h.report())).rejects.toThrow('caller-lineage-unknown');
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow();
    });
    it('refuses a global-secret holder without the launch capability [H2-R-01]', async () => {
        const h = harness(); const host = await h.spawn();
        expect(host.environment).toEqual({ HAPPY_OWNER_CONTACT_FD: '3' });
        expect(host.stdio).toEqual(['ignore', 7, 7, 'pipe']);
        await expect(h.launches.issue(h.report({ capability: 'f'.repeat(43) }))).rejects.toThrow('caller-capability-invalid');
        await expect(h.launches.issue(h.report({ capability: undefined }))).rejects.toThrow();
        // The capability is single-use and bound to its own launch pid.
        await h.launches.issue(h.report());
        await expect(h.launches.issue(h.report())).rejects.toThrow();
    });
    it('cannot use one launch capability for another launch [H2-R-01]', async () => {
        const h = harness(); const other = await h.spawn(99);
        await h.spawn(42);
        await expect(h.launches.issue(h.report({ capability: other.capability }))).rejects.toThrow('caller-capability-invalid');
    });
    it('gives a host recovered after daemon restart no binding [H2-R-01]', async () => {
        const h = harness(); await h.spawn();
        const capability = h.report().capability;
        h.restartDaemon();
        await expect(h.launches.issue(h.report({ capability }))).rejects.toThrow('caller-capability-invalid');
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-unavailable');
    });
    it('is default off: no pipe, no env and nothing issued', async () => {
        const h = harness({ enabled: false });
        expect(h.launches.prepareLaunch({ cwd: '/project' })).toBeNull();
        await expect(h.launches.issue(h.report())).rejects.toThrow('owner-contact-disabled');
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow();
    });
    it.each([
        ['an untracked session', { tracked: null }, {}],
        ['a terminal-started host', { tracked: { startedBy: 'terminal' } }, {}],
        ['another process', {}, { hostPid: 43 }],
        ['scope injection', {}, { scope: '/' }],
        ['depth injection', {}, { depth: 0 }],
    ] as const)('refuses %s', async (_name, options, override) => {
        const h = harness(options as never); await h.spawn();
        await expect(h.launches.issue(h.report(override))).rejects.toThrow();
    });
    it('binds a launch before its session-started webhook but vouches only after it names the same session', async () => {
        const h = harness(); h.webhook(undefined); await h.spawn();
        const issued = await h.launches.issue(h.report());
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-pending');
        h.webhook('source');
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(issued.caller);
        const other = harness(); other.webhook(undefined); await other.spawn();
        await other.launches.issue(other.report()); other.webhook('other-session');
        await expect(other.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-not-running');
    });
    it('refuses a report naming a different session than the launch', async () => {
        const h = harness(); await h.spawn();
        await expect(h.launches.issue(h.report({ sessionId: 'other-session' }))).rejects.toThrow('caller-not-running');
    });
    it('lets only the first report bind a launch', async () => {
        const h = harness(); await h.spawn();
        const first = await h.launches.issue(h.report());
        await expect(h.launches.issue(h.report())).rejects.toThrow();
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(first.caller);
    });
    it('replaces the binding of a resumed launch and rejects the stale one', async () => {
        const h = harness(); await h.spawn();
        const old = await h.launches.issue(h.report());
        h.resume(77); await h.spawn(77);
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-not-running');
        const resumed = await h.launches.issue(h.report({ hostPid: 77, runtimeId: 'resumed-runtime' }));
        expect(resumed.caller.callerBindingId).not.toBe(old.caller.callerBindingId);
        expect(resumed.caller.hostEpoch).not.toBe(old.caller.hostEpoch);
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(resumed.caller);
    });
    it.each(['switchAccount', 'forget', 'changeEpoch'] as const)('current() revokes the binding after %s [H2-R-06]', async action => {
        const h = harness(); await h.spawn();
        const issued = await h.launches.issue(h.report());
        const ask = () => h.launches.current({ sessionId: 'source', callerBindingId: issued.caller.callerBindingId });
        expect(await ask()).toEqual({ current: true });
        h[action]();
        expect(await ask()).toEqual({ current: false });
        h.restoreIdentity();
        expect(await ask()).toEqual({ current: false });
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-unavailable');
    });
    it('query() revokes when the identity lookup fails, like current() [H2-R-06]', async () => {
        const h = harness(); await h.spawn();
        await h.launches.issue(h.report());
        h.failIdentity();
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('identity-changed');
        h.restoreIdentity();
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-unavailable');
    });
    it('current() answers false when the identity lookup fails [H2-R-06]', async () => {
        const h = harness(); await h.spawn();
        const issued = await h.launches.issue(h.report());
        h.failIdentity();
        expect(await h.launches.current({ sessionId: 'source', callerBindingId: issued.caller.callerBindingId })).toEqual({ current: false });
    });
    it.each(['stop', 'switchAccount', 'forget'] as const)('stops vouching after %s', async action => {
        const h = harness(); await h.spawn();
        await h.launches.issue(h.report());
        h[action]();
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow();
    });
    it('refuses without trust configuration', async () => {
        const h = harness();
        const launches = createAgentCallerLaunches({ enabled: true, identity: async () => ({ machineId: 'm', happyAccountId: 'a', epoch: 'e' }),
            trust: () => null, trackedByPid: () => ({ startedBy: 'daemon', pid: 42, directory: '/p' }) as TrackedSession, live: () => true, realpath: p => p });
        const host = await spawnHost(launches, 42);
        await expect(launches.issue(h.report({ capability: host.capability }))).rejects.toThrow('owner-contact-unconfigured');
    });
});
describe('owner-contact trust configuration', () => {
    const env = { HAPPY_SESSION_OWNERSHIP_ENABLED: '1', HAPPY_SESSION_OWNERSHIP_ISSUER: 'https://studio.example',
        HAPPY_SESSION_OWNERSHIP_AUDIENCE: 'https://happy.example', HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: JSON.stringify({ k1: 'x'.repeat(43) }),
        HAPPY_APLUS_STUDIO_ORIGIN: 'https://studio.example' };
    it('reads the daemon ownership trust and its single trusted Studio origin', () => {
        expect(readOwnerContactTrust(env, 'https://happy.example')).toEqual(trust);
    });
    it.each([
        ['ownership disabled', { HAPPY_SESSION_OWNERSHIP_ENABLED: undefined }],
        ['another audience', { HAPPY_SESSION_OWNERSHIP_AUDIENCE: 'https://other.example' }],
        ['malformed keys', { HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: '[1]' }],
        ['an untrusted lookup origin', { HAPPY_APLUS_STUDIO_ORIGIN: 'http://studio.example' }],
    ])('is unavailable with %s', (_name, override) => {
        expect(readOwnerContactTrust({ ...env, ...override }, 'https://happy.example')).toBeNull();
    });
});
