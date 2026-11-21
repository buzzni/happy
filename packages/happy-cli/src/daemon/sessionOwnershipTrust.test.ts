import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { readOwnerContactTrust } from './agentCallerLaunches';
import { ownershipHappyOrigin, ownershipTrustEnv, PINNED_OWNERSHIP_TRUST, pinnedOwnershipTrustProblems, type PinnedOwnershipTrust } from './sessionOwnershipTrust';

const origin = 'https://happy.test';
function entry(audience = origin) {
    const publicKey = Buffer.from(nacl.sign.keyPair().publicKey);
    return { issuer: 'https://studio.test', audience, publicKeys: { [createHash('sha256').update(publicKey).digest('hex')]: publicKey.toString('base64url') } };
}

describe('ownershipTrustEnv', () => {
    it('gives only the trust variables of the daemon\'s own Happy origin when the environment has none', () => {
        const pinned = entry(), table: PinnedOwnershipTrust = { [origin]: pinned };
        expect(ownershipTrustEnv({ HOME: '/home/u', HAPPY_SERVER_URL: origin }, origin, table)).toEqual({
            HAPPY_SESSION_OWNERSHIP_ENABLED: '1', HAPPY_SESSION_OWNERSHIP_ISSUER: pinned.issuer,
            HAPPY_SESSION_OWNERSHIP_AUDIENCE: origin, HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: JSON.stringify(pinned.publicKeys) });
    });

    it.each([
        ['an operator override', { HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: '{}' }],
        ['an audience-only override', { HAPPY_SESSION_OWNERSHIP_AUDIENCE: origin }],
        ['the per-machine off switch', { HAPPY_SESSION_OWNERSHIP_ENABLED: '0' }],
        ['an empty value', { HAPPY_SESSION_OWNERSHIP_ISSUER: '' }],
    ])('lets %s win whole instead of merging it with the table', (_name, env) => {
        expect(ownershipTrustEnv({ HOME: '/home/u', ...env }, origin, { [origin]: entry() })).toEqual(env);
    });

    it('trusts nothing for a Happy origin it does not pin, such as a self-hosted server', () => {
        expect(ownershipTrustEnv({}, 'https://self-hosted.test', { [origin]: entry() })).toEqual({});
    });

    it('ignores an entry that fails its own check instead of trusting part of it', () => {
        const good = entry(), [keyId] = Object.keys(good.publicKeys);
        for (const bad of [
            entry('https://other.test'),
            { ...good, publicKeys: { [keyId]: Buffer.alloc(32, 1).toString('base64url') } },
            { ...good, publicKeys: { [keyId]: good.publicKeys[keyId] + 'A' } },
            { ...good, publicKeys: {} },
            { ...good, issuer: 'http://studio.test/path' },
        ]) expect(ownershipTrustEnv({}, origin, { [origin]: bad })).toEqual({});
    });

    it('feeds owner contact the pinned trust only together with the explicit Studio origin', () => {
        const pinned = entry(), trust = ownershipTrustEnv({}, origin, { [origin]: pinned });
        expect(readOwnerContactTrust(trust, origin)).toBeNull();
        expect(readOwnerContactTrust({ HAPPY_APLUS_STUDIO_ORIGIN: 'https://studio.test', ...trust }, origin))
            .toEqual({ issuer: pinned.issuer, audience: origin, publicKeys: pinned.publicKeys, lookupOrigin: 'https://studio.test' });
    });
});

describe('ownershipHappyOrigin', () => {
    it.each([
        ['https://saycode.ai/', 'https://saycode.ai'],
        ['https://saycode.ai', 'https://saycode.ai'],
        ['http://localhost:3005/', 'http://localhost:3005'],
        ['https://example.test/api/', 'https://example.test/api/'],
        ['not a url', 'not a url'],
    ])('reads %s as %s', (serverUrl, expected) => {
        expect(ownershipHappyOrigin(serverUrl)).toBe(expected);
    });
});

describe('PINNED_OWNERSHIP_TRUST', () => {
    it('ships only entries that pass their own check', () => {
        expect(pinnedOwnershipTrustProblems(PINNED_OWNERSHIP_TRUST)).toEqual([]);
    });

    it('ships the same bytes as Desktop config/session-ownership-trust.v1.json', () => {
        // Change both repos together: Desktop tests/sessionOwnershipTrustPins.test.ts pins the same digest.
        const bytes = readFileSync(join(__dirname, 'sessionOwnershipTrust.v1.json'));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe('e930e56b0dfbb72b6544c09a73a67b0670896ca0e9622f0d23bccb3c40061492');
    });
});
