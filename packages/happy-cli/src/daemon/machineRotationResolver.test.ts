import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { rotationSha256 } from '@slopus/happy-wire';
import { createMachineRotationResolver } from './machineRotationResolver';

// aplus specs/shared-machine-server-signing Phase 3c — machine rotation is on by default: the company is the shared scope,
// Studio and its rotation key come from the trusted origin, and a PC Studio does not accept runs the current way.
const studioOrigin = 'https://studio.example.com', happyOrigin = 'https://happy.example.com';
const key = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64url');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(options: { env?: Record<string, string>; origin?: string | null; accepted?: boolean | 'error'; servedKey?: Record<string, unknown> } = {}) {
    let now = 1_000_000;
    const keyId = await rotationSha256(Buffer.from(key, 'base64url'));
    const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/public-key')) return json(200, options.servedKey ?? { version: 2, algorithm: 'Ed25519', keyId, publicKey: key, studioOrigin, happyOrigin });
        if (path.endsWith('/acceptance')) return options.accepted === 'error' ? json(503, {}) : json(200, { version: 2, accepted: options.accepted ?? true });
        throw new Error('unexpected ' + path);
    });
    const createRuntime = vi.fn((config: { companyId: string; studioPublicKey: string }) => ({ config }) as never);
    const resolver = createMachineRotationResolver({ env: options.env ?? {}, machineId: 'pc', happyOrigin,
        studioOrigin: options.origin === undefined ? studioOrigin : options.origin, bearer: () => 'machine-token', fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => now, createRuntime });
    return { resolver, fetch, createRuntime, keyId, advance: (ms: number) => { now += ms; } };
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

it('asks Studio again only after ten minutes, and reuses one runtime per company and key', async () => {
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
