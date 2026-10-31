/**
 * Per-conversation grants and recent refusals (aplus-dev-studio specs/agent-tool-policy R6, R11.3, R13).
 *
 * A grant exists only because a person answered "allow in this conversation" — the hook endpoint
 * never creates one. Grants live in this session process and die with it. A session started away
 * from this PC gets a 30-minute TTL; the daemon cannot yet tell where a session was started, so
 * the caller passes `grantTtlMs` for every session until Desktop reports the origin (I1c).
 *
 * A grant answers a prompt, and the prompt may still be open when the person revokes that grant —
 * a second call asking in parallel, or one left waiting. That answer must not bring it back: the
 * gate notes `revision()` before it asks and hands it to `grant`, which skips any key revoked since.
 * The call itself was still allowed; only the grant for later calls is dropped.
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
    /**
     * The organization requirements revision the session enforced when the person granted this
     * (null: no document). An organization `ask` newer than it asks again (codexcli-org-requirements R1a).
     */
    orgRevision: number | null;
}

export interface PolicyGrantStore {
    view(): PolicyGrantView;
    /** Counts revokes; pass the value read before asking to `grant`. */
    revision(): number;
    /** `askedAt`: a `revision()` from before the prompt — keys revoked after it are not granted. */
    grant(keys: string[], askedAt?: number, orgRevision?: number | null): void;
    recordDenial(key: string): void;
    /** R13: the person's next message lifts the refusal memory. */
    onUserMessage(): void;
    /** R18: true when a live grant was removed; an expired or unknown key is false. Either way an
     *  answer to a prompt asked before this revoke no longer grants the key. */
    revoke(key: string): boolean;
    list(): PolicyGrantRecord[];
    clear(): void;
}

export function createPolicyGrantStore(options: { now?: () => number; grantTtlMs?: number | null } = {}): PolicyGrantStore {
    const now = options.now ?? Date.now;
    const ttl = options.grantTtlMs ?? null;
    const grants = new Map<string, PolicyGrantRecord>();
    const denials = new Map<string, number>();
    let revision = 0;
    const revokedAt = new Map<string, number>();

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
            grantRevision: (key) => {
                const record = grants.get(key);
                return live(record) ? record!.orgRevision : undefined;
            },
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
        revision: () => revision,
        grant: (keys, askedAt, orgRevision = null) => {
            const createdAt = now();
            for (const key of keys) {
                if (askedAt !== undefined && (revokedAt.get(key) ?? 0) > askedAt) continue;
                grants.set(key, { key, createdAt, expiresAt: ttl === null ? null : createdAt + ttl, orgRevision });
            }
        },
        recordDenial: (key) => { denials.set(key, now()); },
        onUserMessage: () => { denials.clear(); },
        revoke: (key) => {
            revokedAt.set(key, ++revision);
            return live(grants.get(key)) && grants.delete(key);
        },
        list: () => [...grants.values()].filter((record) => live(record)),
        clear: () => { grants.clear(); denials.clear(); },
    };
}
