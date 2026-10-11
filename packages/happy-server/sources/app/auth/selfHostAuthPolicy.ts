import { createHash } from "node:crypto";

/**
 * Auth hardening for a server that one owner self-hosts on the public internet
 * (aplus-dev-studio-desktop specs/headless-standalone-server R6, R7, R17).
 *
 * Every switch is opt-in through env so the cloud server, which runs this same
 * code, keeps its current behavior. A configured-but-unusable allowlist is a
 * startup error: silently falling back to open sign-up is the failure this exists
 * to prevent.
 */
export interface SelfHostAuthPolicy {
    /** Ed25519 public keys (hex) allowed to sign in; null = anyone (cloud default). */
    allowedPublicKeysHex: Set<string> | null;
    /** Single-use challenges and pairing codes, pairing TTL, request limits. */
    hardened: boolean;
    pairingTtlMs: number;
    trustProxy: boolean;
}

const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const ED25519_PUBLIC_KEY_BYTES = 32;

function decodeKey(raw: string): Buffer {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error(`HAPPY_AUTH_ALLOWED_PUBLIC_KEYS has a non-base64 entry`);
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) throw new Error(`HAPPY_AUTH_ALLOWED_PUBLIC_KEYS entries must be 32-byte Ed25519 keys`);
    return bytes;
}

export function readSelfHostAuthPolicy(env: Record<string, string | undefined>): SelfHostAuthPolicy {
    const rawAllowlist = env.HAPPY_AUTH_ALLOWED_PUBLIC_KEYS;
    let allowedPublicKeysHex: Set<string> | null = null;
    if (rawAllowlist !== undefined) {
        const entries = rawAllowlist.split(",").map((entry) => entry.trim()).filter(Boolean);
        if (entries.length === 0) throw new Error("HAPPY_AUTH_ALLOWED_PUBLIC_KEYS is set but lists no key");
        allowedPublicKeysHex = new Set(entries.map((entry) => decodeKey(entry).toString("hex")));
    }
    const hardened = env.HAPPY_SELF_HOST_HARDENING === "1";
    if (hardened && !allowedPublicKeysHex) throw new Error("HAPPY_SELF_HOST_HARDENING requires HAPPY_AUTH_ALLOWED_PUBLIC_KEYS");
    const ttl = env.HAPPY_AUTH_PAIRING_TTL_MS ? Number(env.HAPPY_AUTH_PAIRING_TTL_MS) : DEFAULT_PAIRING_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("HAPPY_AUTH_PAIRING_TTL_MS must be a positive number");
    return { allowedPublicKeysHex, hardened, pairingTtlMs: ttl, trustProxy: env.HAPPY_TRUST_PROXY === "1" };
}

/** Short, non-reversible label for logs; full public keys stay out of a public server's logs. */
export function keyFingerprint(publicKeyHex: string): string {
    return createHash("sha256").update(publicKeyHex).digest("hex").slice(0, 12);
}

/**
 * Remembers signed challenges for a while so the same signature cannot mint a
 * second token. In memory only: a restart forgets it (documented residual risk).
 */
export function createReplayGuard(ttlMs: number, maxEntries = 10_000) {
    const seen = new Map<string, number>();
    return (publicKeyHex: string, challenge: string, now: number): boolean => {
        for (const [key, expiresAt] of seen) {
            if (expiresAt > now && seen.size < maxEntries) break;
            seen.delete(key);
        }
        const key = createHash("sha256").update(`${publicKeyHex}:${challenge}`).digest("hex");
        if ((seen.get(key) ?? 0) > now) return false;
        seen.set(key, now + ttlMs);
        return true;
    };
}

/** Fixed-window counters per key. Returns seconds to wait, or 0 when allowed. */
export function createRateLimiter(limits: Record<string, { limit: number; windowMs: number }>) {
    const windows = new Map<string, { start: number; count: number }>();
    return (bucket: string, key: string, now: number): number => {
        const rule = limits[bucket];
        const id = `${bucket}:${key}`;
        const current = windows.get(id);
        if (!current || now - current.start >= rule.windowMs) {
            if (windows.size > 50_000) windows.clear();
            windows.set(id, { start: now, count: 1 });
            return 0;
        }
        current.count += 1;
        return current.count > rule.limit ? Math.ceil((current.start + rule.windowMs - now) / 1000) : 0;
    };
}

export const AUTH_FIELD_MAX_LENGTH = { publicKey: 64, challenge: 512, signature: 128, response: 4096 } as const;
