import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { createAgentCallerLaunches, readOwnerContactTrust } from './agentCallerLaunches';
import type { TrackedSession } from './types';

const key = () => Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url');
const trust = { issuer: 'https://studio.example', audience: 'https://happy.example', publicKeys: { k1: 'x'.repeat(43) }, lookupOrigin: 'https://studio.example' };
function harness(options: { enabled?: boolean; tracked?: Partial<TrackedSession> | null } = {}) {
    let identity: { machineId: string; happyAccountId: string; epoch: string } | null = { machineId: 'machine', happyAccountId: 'account', epoch: 'e1' };
    let alive = true;
    let session: TrackedSession | undefined = options.tracked === null ? undefined : { startedBy: 'daemon', pid: 42, directory: '/project',
        happySessionId: 'source', ...options.tracked } as TrackedSession;
    const launches = createAgentCallerLaunches({ enabled: options.enabled ?? true, identity: async () => identity, trust: () => trust,
        trackedByPid: pid => pid === session?.pid ? session : undefined, live: () => alive, realpath: path => path });
    const report = (override: Record<string, unknown> = {}) => ({ sessionId: 'source', runtimeId: 'actual-runtime', hostPid: 42, callerPublicKey: key(), ...override });
    return { launches, report, stop: () => { alive = false; }, resume: (pid: number) => { session = { ...session!, pid }; },
        webhook: (id: string | undefined) => { session = { ...session!, happySessionId: id }; },
        switchAccount: () => { identity = { ...identity!, happyAccountId: 'other' }; }, forget: () => { identity = null; } };
}
const nonce = 'n'.repeat(32);
describe('daemon launch caller bindings', () => {
    it('issues a binding from the daemon launch state, not the host report', async () => {
        const h = harness({ tracked: { agentEnvironment: { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/project', SAYCODE_AGENT_DEPTH: '2', SAYCODE_AGENT_SCOPE: '/scope' } } });
        const report = h.report({});
        const issued = await h.launches.issue(report);
        expect(issued.caller).toMatchObject({ sessionId: 'source', runtimeId: 'actual-runtime', machineId: 'machine', happyAccountId: 'account',
            scope: '/scope', depth: 2, callerPublicKey: report.callerPublicKey });
        expect(issued.trust).toEqual(trust);
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(issued.caller);
    });
    it('defaults an unadmitted agent environment to depth 0 at the launch directory', async () => {
        const issued = await harness().launches.issue(harness().report());
        expect(issued.caller).toMatchObject({ scope: '/project', depth: 0 });
    });
    it('is default off and issues nothing', async () => {
        const h = harness({ enabled: false });
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
        const h = harness(options as never);
        await expect(h.launches.issue(h.report(override))).rejects.toThrow();
    });
    it('binds a launch before its session-started webhook but vouches only after it names the same session', async () => {
        const h = harness(); h.webhook(undefined);
        const issued = await h.launches.issue(h.report());
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-pending');
        h.webhook('source');
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(issued.caller);
        const other = harness(); other.webhook(undefined);
        await other.launches.issue(other.report()); other.webhook('other-session');
        await expect(other.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-not-running');
    });
    it('refuses a report naming a different session than the launch', async () => {
        const h = harness();
        await expect(h.launches.issue(h.report({ sessionId: 'other-session' }))).rejects.toThrow('caller-not-running');
    });
    it('lets only the first report bind a launch', async () => {
        const h = harness();
        const first = await h.launches.issue(h.report());
        await expect(h.launches.issue(h.report())).rejects.toThrow('caller-already-bound');
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(first.caller);
    });
    it('replaces the binding of a resumed launch and rejects the stale one', async () => {
        const h = harness();
        const old = await h.launches.issue(h.report());
        h.resume(77);
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow('caller-not-running');
        const resumed = await h.launches.issue(h.report({ hostPid: 77, runtimeId: 'resumed-runtime' }));
        expect(resumed.caller.callerBindingId).not.toBe(old.caller.callerBindingId);
        expect(resumed.caller.hostEpoch).not.toBe(old.caller.hostEpoch);
        expect((await h.launches.query({ sessionId: 'source', nonce })).caller).toEqual(resumed.caller);
    });
    it.each(['stop', 'switchAccount', 'forget'] as const)('stops vouching after %s', async action => {
        const h = harness();
        await h.launches.issue(h.report());
        h[action]();
        await expect(h.launches.query({ sessionId: 'source', nonce })).rejects.toThrow();
    });
    it('refuses without trust configuration', async () => {
        const h = harness();
        const launches = createAgentCallerLaunches({ enabled: true, identity: async () => ({ machineId: 'm', happyAccountId: 'a', epoch: 'e' }),
            trust: () => null, trackedByPid: () => ({ startedBy: 'daemon', pid: 42, directory: '/p' }) as TrackedSession, live: () => true, realpath: p => p });
        await expect(launches.issue(h.report())).rejects.toThrow('owner-contact-unconfigured');
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
