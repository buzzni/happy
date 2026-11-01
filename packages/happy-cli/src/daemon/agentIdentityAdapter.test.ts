import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { rotationBase64url, signOwnership } from '@slopus/happy-wire';
import { createAgentIdentityAdapter } from './agentIdentityAdapter';
import { createAgentIdentityAuthority } from './agentIdentityDescriptor';

const NOW = 1_800_000_000_000;
const keys = nacl.sign.keyPair();
const keyId = createHash('sha256').update(keys.publicKey).digest('hex');
const trust = { issuer: 'https://studio.example', audience: 'https://happy.example',
    publicKeys: { [keyId]: rotationBase64url(keys.publicKey) }, lookupOrigin: 'https://studio.example' };
const binding = { machineId: 'machine-1', happyAccountId: 'account-a', hostEpoch: 'epoch-1' };
const descriptor = (override: Record<string, unknown> = {}, secretKey = keys.secretKey) => signOwnership({
    version: 1, type: 'saycode-machine-agent-identity', issuer: trust.issuer, audience: trust.audience, keyId,
    issuedAt: NOW - 1_000, expiresAt: NOW + 30_000, descriptorId: 'descriptor-1', machineId: 'machine-1', happyAccountId: 'account-a',
    ownerSubject: { issuer: trust.issuer, userId: 'user-1' }, registrationType: 'personal', accountKind: 'personal',
    registrationRevision: 'a'.repeat(64), observedAt: NOW - 1_000, ...override,
} as never, secretKey) as unknown as Record<string, unknown>;

function harness(options: { sameAccount?: unknown; descriptor?: unknown; current?: boolean; token?: string | null; status?: number } = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        const body = String(url).endsWith('/agent-identity') ? { descriptor: options.descriptor ?? descriptor() } : { sameAccount: options.sameAccount ?? true };
        return new Response(JSON.stringify(body), { status: options.status ?? 200 });
    });
    const deps = createAgentIdentityAdapter({ binding, trust, happyOrigin: 'https://happy.example',
        current: async () => options.current ?? true, token: async () => options.token === undefined ? 'happy-token' : options.token,
        fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW });
    return { deps, calls, fetch, authority: createAgentIdentityAuthority(deps) };
}

describe('agent identity adapter (Desktop identity-adapter-plan H-C)', () => {
    it('reads the issued binding as state and proves a same-account sibling end to end', async () => {
        const h = harness();
        expect(h.deps.readState()).toEqual({ machineId: 'machine-1', happyAccountId: 'account-a', epoch: 'epoch-1' });
        expect(await h.authority.inspect('target')).toEqual({ relation: 'own-sibling', proof: 'personal-same-account', reason: 'same-account' });
        expect(h.calls.map(c => c.url)).toEqual(['https://studio.example/api/v2/machines/machine-1/agent-identity',
            'https://happy.example/v1/session-ownership/same-account']);
        for (const call of h.calls) {
            expect(call.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer happy-token', 'content-type': 'application/json' } });
        }
        expect(JSON.parse(String(h.calls[1].init.body))).toEqual({ sessionId: 'target' });
    });

    it('maps a different account to other and an unanswerable server to unknown', async () => {
        expect(await harness({ sameAccount: false }).authority.inspect('target')).toMatchObject({ relation: 'other', reason: 'different-account' });
        const old = harness();
        old.fetch.mockImplementation(async (url: string | URL | Request) => String(url).endsWith('/agent-identity')
            ? new Response(JSON.stringify({ descriptor: descriptor() })) : new Response('{}', { status: 404 }));
        expect(await old.authority.inspect('target')).toMatchObject({ relation: 'unknown', reason: 'target-owner-unknown' });
    });

    it.each([
        ['an unpinned key', descriptor({}, nacl.sign.keyPair().secretKey)],
        ['a key id that is not the key hash', { ...descriptor(), keyId: 'b'.repeat(64) }],
        ['another issuer', descriptor({ issuer: 'https://evil.example', ownerSubject: { issuer: 'https://evil.example', userId: 'u' } })],
        ['another audience', descriptor({ audience: 'https://other.example' })],
        ['an expired descriptor', descriptor({ issuedAt: NOW - 90_000, expiresAt: NOW - 30_000, observedAt: NOW - 90_000 })],
        ['a tampered field', { ...descriptor(), happyAccountId: 'account-b' }],
        ['a company registration', descriptor({ registrationType: 'company', accountKind: 'company', ownerSubject: null })],
    ])('never proves own with %s', async (_name, raw) => {
        const h = harness({ descriptor: raw });
        expect((await h.authority.inspect('target')).relation).not.toBe('own-sibling');
        expect(h.calls.some(c => c.url.endsWith('/same-account'))).toBe(false);
    });

    it('stops before any request when the daemon no longer vouches or no token exists', async () => {
        for (const options of [{ current: false }, { token: null }]) {
            const h = harness(options);
            expect(await h.authority.inspect('target')).toMatchObject({ relation: 'unknown', reason: 'identity-unavailable' });
            expect(h.fetch).not.toHaveBeenCalled();
        }
    });

    it('rejects an oversized or non-JSON answer as unknown', async () => {
        const h = harness();
        h.fetch.mockImplementation(async () => new Response('x'.repeat(70_000)));
        expect(await h.authority.inspect('target')).toMatchObject({ relation: 'unknown' });
    });
});
