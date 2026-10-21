import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { rotationSha256 } from '@slopus/happy-wire';
import { chooseLaunchRotation, createMachineRotationResolver } from './machineRotationResolver';

// aplus specs/shared-machine-server-signing Phase 3c — machine rotation is on by default: the company is the shared scope,
// Studio and its rotation key come from the trusted origin, and a PC Studio does not accept runs the current way.
const studioOrigin = 'https://studio.example.com', happyOrigin = 'https://happy.example.com';
const key = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(options: { env?: Record<string, string>; origin?: string | null; accepted?: boolean | 'error'; servedKey?: Record<string, unknown>; keyFailures?: number } = {}) {
    let now = 1_000_000;
    const keyId = await rotationSha256(Buffer.from(key, 'base64url'));
    const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/public-key')) {
            if (options.keyFailures && options.keyFailures-- > 0) return json(503, {});
            return json(200, options.servedKey ?? { version: 2, algorithm: 'Ed25519', keyId, publicKey: key, studioOrigin, happyOrigin });
        }
        if (path.endsWith('/acceptance')) return options.accepted === 'error' ? json(503, {}) : json(200, { version: 2, accepted: options.accepted ?? true });
        throw new Error('unexpected ' + path);
    });
    const createRuntime = vi.fn((config: { companyId: string; studioPublicKey: string }) => ({ config }) as never);
    const resolver = createMachineRotationResolver({ env: options.env ?? {}, machineId: 'pc', happyOrigin,
        studioOrigin: options.origin === undefined ? studioOrigin : options.origin, bearer: () => 'machine-token', fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => now, createRuntime });
    return { resolver, fetch, createRuntime, keyId, options, advance: (ms: number) => { now += ms; } };
}

it('issues new launches by default for an accepted shared PC, with Studio and its key from the trusted origin', async () => {
    const f = await fixture();
    const decision = await f.resolver.newLaunch('co');
    expect(decision).toMatchObject({ runtime: { config: { companyId: 'co', machineId: 'pc', studioOrigin, happyOrigin, studioPublicKey: key } } });
    const acceptance = f.fetch.mock.calls.find(([url]) => String(url).includes('/acceptance'))!;
    expect(String(acceptance[0])).toBe(`${studioOrigin}/api/claude-setup-token/daemon/v2/acceptance?companyId=co&machineId=pc`);
    expect(acceptance[1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer machine-token' } });
});

it('runs the current way, with a reason, when forced off, without a trusted origin, when not accepted or when Studio cannot say', async () => {
    for (const [options, reason] of [
        [{ env: { HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED: 'false' } }, 'DISABLED'],
        [{ env: { HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED: 'off' } }, 'DISABLED'],
        [{ origin: null }, 'STUDIO_ORIGIN_MISSING'],
        [{ accepted: false }, 'NOT_ACCEPTED'],
        [{ accepted: 'error' }, 'ACCEPTANCE_UNAVAILABLE'],
    ] as const) {
        const f = await fixture(options);
        await expect(f.resolver.newLaunch('co')).resolves.toEqual({ runtime: null, reason });
        expect(f.resolver.newIssuesAllowed()).toBe(reason !== 'DISABLED');
    }
});

it('refuses a served key that does not match its id or the trusted origins', async () => {
    const keyId = await rotationSha256(Buffer.from(key, 'base64url'));
    for (const servedKey of [
        { version: 2, algorithm: 'Ed25519', keyId: 'f'.repeat(64), publicKey: key, studioOrigin, happyOrigin },
        { version: 2, algorithm: 'Ed25519', keyId, publicKey: key, studioOrigin: 'https://evil.example.com', happyOrigin },
        { version: 2, algorithm: 'Ed25519', keyId, publicKey: key, studioOrigin, happyOrigin: 'https://other.example.com' },
    ]) {
        const f = await fixture({ servedKey });
        await expect(f.resolver.newLaunch('co')).resolves.toEqual({ runtime: null, reason: 'STUDIO_KEY_UNAVAILABLE' });
        expect(f.createRuntime).not.toHaveBeenCalled();
    }
});

it('keeps recovering existing launches even when new issuance is off', async () => {
    const f = await fixture({ env: { HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED: 'false' }, accepted: false });
    await expect(f.resolver.runtime('co')).resolves.toMatchObject({ config: { companyId: 'co' } });
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain('/api/claude-setup-token/daemon/v2/acceptance');
});

// Review #896 (medium) — one runtime per company keeps its launch fencing; a new Studio key only refreshes it.
it('keeps one runtime per company across a Studio key rotation, refreshing the key it verifies with', async () => {
    const f = await fixture();
    const first = await f.resolver.newLaunch('co');
    const rotated = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url');
    f.options.servedKey = { version: 2, algorithm: 'Ed25519', keyId: await rotationSha256(Buffer.from(rotated, 'base64url')), publicKey: rotated, studioOrigin, happyOrigin };
    f.advance(10 * 60_000 + 1);
    const later = await f.resolver.newLaunch('co');
    expect(later.runtime).toBe(first.runtime);
    expect(f.createRuntime).toHaveBeenCalledTimes(1);
    expect((later.runtime as unknown as { config: { studioPublicKey: string } }).config.studioPublicKey).toBe(rotated);
});

// Review #896 (low) — a hanging or failing Studio costs one wait per minute, not one per launch.
it('remembers a failed key or acceptance lookup for a minute and shares one lookup between concurrent launches', async () => {
    const failing = await fixture({ accepted: 'error' });
    await Promise.all([failing.resolver.newLaunch('co'), failing.resolver.newLaunch('co')]);
    await failing.resolver.newLaunch('co');
    const acceptanceCalls = () => failing.fetch.mock.calls.filter(([url]) => String(url).includes('/acceptance')).length;
    expect(acceptanceCalls()).toBe(1);
    failing.advance(60_001);
    await failing.resolver.newLaunch('co');
    expect(acceptanceCalls()).toBe(2);

    const keyless = await fixture({ keyFailures: 5 });
    await Promise.all([keyless.resolver.newLaunch('co'), keyless.resolver.newLaunch('co')]);
    await expect(keyless.resolver.newLaunch('co')).resolves.toEqual({ runtime: null, reason: 'STUDIO_KEY_UNAVAILABLE' });
    expect(keyless.fetch.mock.calls.filter(([url]) => String(url).includes('/public-key'))).toHaveLength(1);
});

it('asks Studio again only after ten minutes, and reuses one runtime per company', async () => {
    const f = await fixture();
    const first = await f.resolver.newLaunch('co');
    await f.resolver.newLaunch('co');
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.createRuntime).toHaveBeenCalledTimes(1);
    f.advance(10 * 60_000 + 1);
    const later = await f.resolver.newLaunch('co');
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(later.runtime).toBe(first.runtime);
    await f.resolver.newLaunch('other');
    expect(f.createRuntime).toHaveBeenCalledTimes(2);
});

// Review #896 (high) — the decision for one launch: cheap opt-outs first, and an unresolved assignment is a fallback,
// never a failed launch (a PC assigned to two companies or with a pending assignment must still start Claude).
describe('chooseLaunchRotation', () => {
    type Decision = { runtime: 'runtime'; reason?: undefined } | { runtime: null; reason: 'ACCEPTANCE_UNAVAILABLE' };
    const resolver = (newLaunch = vi.fn(async (): Promise<Decision> => ({ runtime: 'runtime' }))) => ({ newIssuesAllowed: () => true, newLaunch });
    const base = (overrides: Partial<Parameters<typeof chooseLaunchRotation<'runtime'>>[0]> = {}) => {
        const log = vi.fn(), scope = vi.fn(async () => 'co' as string | null);
        return { log, scope, input: { managedClaude: true, explicitUserGrant: false, precreatedSession: false, resolver: resolver(), scope, log, ...overrides } };
    };

    it('uses the runtime Studio accepts for the shared scope', async () => {
        const f = base();
        await expect(chooseLaunchRotation(f.input)).resolves.toBe('runtime');
        expect(f.log).not.toHaveBeenCalled();
    });

    it('never resolves the scope when rotation is forced off, unavailable, or not a managed Claude launch', async () => {
        for (const overrides of [
            { resolver: { newIssuesAllowed: () => false, newLaunch: vi.fn() } }, { resolver: null }, { managedClaude: false }, { explicitUserGrant: true },
        ]) {
            const f = base(overrides);
            await expect(chooseLaunchRotation(f.input)).resolves.toBeNull();
            expect(f.scope).not.toHaveBeenCalled();
        }
    });

    it('runs the current way when the shared assignment cannot be resolved, instead of failing the launch', async () => {
        const f = base();
        f.scope.mockRejectedValueOnce(new Error('CLAUDE_SETUP_TOKEN_ASSIGNMENT_UNRESOLVED'));
        await expect(chooseLaunchRotation(f.input)).resolves.toBeNull();
        expect(f.log).toHaveBeenCalledWith('ASSIGNMENT_UNRESOLVED', false);
    });

    it('runs the current way for a precreated session or a refusal, logging unexpected reasons louder', async () => {
        const precreated = base({ precreatedSession: true });
        await expect(chooseLaunchRotation(precreated.input)).resolves.toBeNull();
        expect(precreated.log).toHaveBeenCalledWith('PRECREATED_SESSION', false);
        const unavailable = base({ resolver: resolver(vi.fn(async (): Promise<Decision> => ({ runtime: null, reason: 'ACCEPTANCE_UNAVAILABLE' }))) });
        await expect(chooseLaunchRotation(unavailable.input)).resolves.toBeNull();
        expect(unavailable.log).toHaveBeenCalledWith('ACCEPTANCE_UNAVAILABLE', true);
        const noScope = base();
        noScope.scope.mockResolvedValueOnce(null);
        await expect(chooseLaunchRotation(noScope.input)).resolves.toBeNull();
        expect(noScope.log).not.toHaveBeenCalled();
    });
});
