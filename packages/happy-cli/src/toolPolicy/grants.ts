/**
 * Per-conversation grants and recent refusals (aplus-dev-studio specs/agent-tool-policy R6, R11.3, R13).
 *
 * A grant exists only because a person answered "allow in this conversation" — the hook endpoint
 * never creates one. Grants live in this session process and die with it. A session started away
 * from this PC gets a 30-minute TTL; the daemon cannot yet tell where a session was started, so
 * the caller passes `grantTtlMs` for every session until Desktop reports the origin (I1c).
 *
 * A refusal is remembered for 5 minutes per (tool, target) so the same prompt does not come back
 * in a loop, and is forgotten as soon as the person sends their next message.
 */

import type { PolicyGrantView } from './evaluate';

export const REMOTE_GRANT_TTL_MS = 30 * 60 * 1000;
export const DENIAL_MEMORY_MS = 5 * 60 * 1000;

export interface PolicyGrantRecord {
    key: string;
    createdAt: number;
    expiresAt: number | null;
}

export interface PolicyGrantStore {
    view(): PolicyGrantView;
    grant(keys: string[]): void;
    recordDenial(key: string): void;
    /** R13: the person's next message lifts the refusal memory. */
    onUserMessage(): void;
    /** R18: true when a live grant was removed; an expired or unknown key is false. */
    revoke(key: string): boolean;
    list(): PolicyGrantRecord[];
    clear(): void;
}

export function createPolicyGrantStore(options: { now?: () => number; grantTtlMs?: number | null } = {}): PolicyGrantStore {
    const now = options.now ?? Date.now;
    const ttl = options.grantTtlMs ?? null;
    const grants = new Map<string, PolicyGrantRecord>();
    const denials = new Map<string, number>();

    const live = (record: PolicyGrantRecord | undefined): boolean => {
        if (!record) return false;
        if (record.expiresAt !== null && record.expiresAt <= now()) {
            grants.delete(record.key);
            return false;
        }
        return true;
    };

    return {
        view: () => ({
            hasGrant: (key) => live(grants.get(key)),
            recentlyDenied: (key) => {
                const at = denials.get(key);
                if (at === undefined) return false;
                if (now() - at >= DENIAL_MEMORY_MS) {
                    denials.delete(key);
                    return false;
                }
                return true;
            },
        }),
        grant: (keys) => {
            const createdAt = now();
            for (const key of keys) grants.set(key, { key, createdAt, expiresAt: ttl === null ? null : createdAt + ttl });
        },
        recordDenial: (key) => { denials.set(key, now()); },
        onUserMessage: () => { denials.clear(); },
        revoke: (key) => live(grants.get(key)) && grants.delete(key),
        list: () => [...grants.values()].filter((record) => live(record)),
        clear: () => { grants.clear(); denials.clear(); },
    };
}
