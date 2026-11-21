import { createHash } from 'node:crypto';
import { RotationOriginSchema, rotationDecodeBinary } from '@slopus/happy-wire';

/** Public A+ ownership signing trust, keyed by the Happy origin it is issued for (its `audience`). */
export type PinnedOwnershipTrust = Readonly<Record<string, { issuer: string; audience: string; publicKeys: Readonly<Record<string, string>> }>>;

/**
 * D5 (Desktop specs/reason-network-adoption/d5-ownership-trust-distribution.md): the trust a released daemon uses when its
 * environment names none. Public keys only (`keyId` = sha256 of the 32-byte Ed25519 key); Desktop ships the same table.
 * A rotation lists the old and the next key together before A+ switches signing.
 */
export const PINNED_OWNERSHIP_TRUST: PinnedOwnershipTrust = {};

const TRUST_ENV = ['HAPPY_SESSION_OWNERSHIP_ENABLED', 'HAPPY_SESSION_OWNERSHIP_ISSUER', 'HAPPY_SESSION_OWNERSHIP_AUDIENCE', 'HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS'] as const;

function entryValid(origin: string, entry: PinnedOwnershipTrust[string]): boolean {
    try {
        const keys = Object.entries(entry.publicKeys);
        return RotationOriginSchema.safeParse(entry.issuer).success && entry.audience === origin && RotationOriginSchema.safeParse(origin).success
            && keys.length > 0 && keys.every(([keyId, key]) => createHash('sha256').update(rotationDecodeBinary(key, 32)).digest('hex') === keyId);
    } catch { return false; }
}

/** Origins whose pinned entry fails its own check; the shipped table must have none. */
export function pinnedOwnershipTrustProblems(table: PinnedOwnershipTrust): string[] {
    return Object.keys(table).filter(origin => !entryValid(origin, table[origin]));
}

/**
 * The environment the ownership verifiers read. Any ownership trust variable in the environment (including
 * `HAPPY_SESSION_OWNERSHIP_ENABLED=0`, the per-machine off switch) wins whole and is never merged with the table.
 * Trust alone enables no feature: the Desktop creation flag and HAPPY_OWNER_CONTACT_V1 still gate their use.
 */
export function withPinnedOwnershipTrust(env: NodeJS.ProcessEnv, happyOrigin: string, table: PinnedOwnershipTrust = PINNED_OWNERSHIP_TRUST): NodeJS.ProcessEnv {
    if (TRUST_ENV.some(name => env[name] !== undefined) || !Object.hasOwn(table, happyOrigin)) return env;
    const entry = table[happyOrigin];
    if (!entryValid(happyOrigin, entry)) return env;
    return { ...env, HAPPY_SESSION_OWNERSHIP_ENABLED: '1', HAPPY_SESSION_OWNERSHIP_ISSUER: entry.issuer,
        HAPPY_SESSION_OWNERSHIP_AUDIENCE: entry.audience, HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS: JSON.stringify(entry.publicKeys) };
}
