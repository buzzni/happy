import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { PINNED_OWNERSHIP_TRUST, pinnedOwnershipTrustProblems, withPinnedOwnershipTrust, type PinnedOwnershipTrust } from './sessionOwnershipTrust';

const origin = 'https://happy.test';
function entry(audience = origin) {
    const publicKey = Buffer.from(nacl.sign.keyPair().publicKey);
    return { issuer: 'https://studio.test', audience, publicKeys: { [createHash('sha256').update(publicKey).digest('hex')]: publicKey.toString('base64url') } };
}

describe('withPinnedOwnershipTrust', () => {
    it('fills the ownership trust of the daemon\'s own Happy origin when the environment has none', () => {
        const pinned = entry(), table: PinnedOwnershipTrust = { [origin]: pinned };
        expect(withPinnedOwnershipTrust({ HOME: '/home/u' }, origin, table)).toEqual({ HOME: '/home/u',
            HAPPY_SESSION_OWNERSHIP_ENABLED: '1', HAPPY_SESSION_OWNERSHIP_ISSUER: pinned.issuer,
            HAPPY_SESSION_OWNERSHIP_AUDIENCE: origin, HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: JSON.stringify(pinned.publicKeys) });
    });

    it.each([
        ['an operator override', { HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: '{}' }],
        ['the per-machine off switch', { HAPPY_SESSION_OWNERSHIP_ENABLED: '0' }],
        ['an empty value', { HAPPY_SESSION_OWNERSHIP_ISSUER: '' }],
    ])('leaves the environment whole when it already carries %s', (_name, env) => {
        expect(withPinnedOwnershipTrust(env, origin, { [origin]: entry() })).toBe(env);
    });

    it('trusts nothing for a Happy origin it does not pin, such as a self-hosted server', () => {
        const env = {};
        expect(withPinnedOwnershipTrust(env, 'https://self-hosted.test', { [origin]: entry() })).toBe(env);
        expect(withPinnedOwnershipTrust(env, `${origin}/`, { [origin]: entry() })).toBe(env);
    });

    it('ignores an entry that fails its own check instead of trusting part of it', () => {
        const good = entry(), [keyId] = Object.keys(good.publicKeys);
        for (const bad of [
            entry('https://other.test'),
            { ...good, publicKeys: { [keyId]: Buffer.alloc(32, 1).toString('base64url') } },
            { ...good, publicKeys: { [keyId]: good.publicKeys[keyId] + 'A' } },
            { ...good, publicKeys: {} },
            { ...good, issuer: 'http://studio.test/path' },
        ]) expect(withPinnedOwnershipTrust({}, origin, { [origin]: bad })).toEqual({});
    });
});

describe('PINNED_OWNERSHIP_TRUST', () => {
    it('ships only entries that pass their own check', () => {
        expect(pinnedOwnershipTrustProblems(PINNED_OWNERSHIP_TRUST)).toEqual([]);
    });
});
