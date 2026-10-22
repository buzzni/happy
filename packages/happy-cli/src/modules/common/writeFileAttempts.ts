/**
 * Idempotent retries for the `writeFile` RPC (aplus-dev-studio specs/claude-cli-benchmark-followups R5).
 *
 * A client that lost the answer to a write sends the same request again. Without a record the
 * hash gate reads its own earlier write as someone else's change and reports a conflict for a
 * save that went through. The client names each write with an `attemptId`; this store remembers
 * what that attempt asked for (path, expected hash, content hash) and the answer it got, so a
 * resend gets the same answer and a different write under the same id is refused.
 *
 * In memory only, bounded by age and count. A record exists to answer retries, which come within
 * one RPC timeout or a user's next save click, so ten minutes is generous. Losing a record (daemon
 * restart, expiry, eviction) never permits an overwrite: the handler falls back to the hash gate,
 * and to "already done" only when the file already holds exactly the requested bytes. Only hashes
 * are kept, never content.
 */

/** Advertised in machine metadata as `writeFileAttempt`; clients send `attemptId` only when present. */
export const WRITE_FILE_ATTEMPT_CAPABILITY = { version: 1 as const };

export const WRITE_FILE_ATTEMPT_TTL_MS = 10 * 60 * 1000;
export const WRITE_FILE_ATTEMPT_MAX_ENTRIES = 512;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidWriteFileAttemptId(value: unknown): value is string {
    return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}

export interface WriteFileAttemptFingerprint {
    path: string;
    expectedHash: string | null;
    contentHash: string;
}

interface Entry<T> {
    fingerprint: WriteFileAttemptFingerprint;
    result: Promise<T>;
    at: number;
}

export type WriteFileAttemptOutcome<T> =
    | { kind: 'first'; result: Promise<T> }
    | { kind: 'replay'; result: Promise<T> }
    | { kind: 'conflict' };

function sameFingerprint(a: WriteFileAttemptFingerprint, b: WriteFileAttemptFingerprint): boolean {
    return a.path === b.path && a.expectedHash === b.expectedHash && a.contentHash === b.contentHash;
}

export function createWriteFileAttemptStore<T extends { success: boolean }>(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    const ttlMs = options.ttlMs ?? WRITE_FILE_ATTEMPT_TTL_MS;
    const maxEntries = options.maxEntries ?? WRITE_FILE_ATTEMPT_MAX_ENTRIES;
    const now = options.now ?? Date.now;
    const entries = new Map<string, Entry<T>>();

    function prune(at: number) {
        for (const [id, entry] of entries) {
            if (at - entry.at < ttlMs) break; // insertion order is age order
            entries.delete(id);
        }
        while (entries.size >= maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
        }
    }

    return {
        /**
         * Run `write` once per attempt. A resend with the same fingerprint shares the first
         * call's answer, including one still in flight. A failed answer is not kept, so a later
         * resend is judged again against the file as it is then.
         */
        run(attemptId: string, fingerprint: WriteFileAttemptFingerprint, write: () => Promise<T>): WriteFileAttemptOutcome<T> {
            const at = now();
            const existing = entries.get(attemptId);
            if (existing && at - existing.at < ttlMs) {
                return sameFingerprint(existing.fingerprint, fingerprint)
                    ? { kind: 'replay', result: existing.result }
                    : { kind: 'conflict' };
            }
            if (existing) entries.delete(attemptId);
            prune(at);
            const result = write().then((answer) => {
                if (!answer.success && entries.get(attemptId)?.result === result) entries.delete(attemptId);
                return answer;
            }, (error: unknown) => {
                if (entries.get(attemptId)?.result === result) entries.delete(attemptId);
                throw error;
            });
            entries.set(attemptId, { fingerprint, result, at });
            return { kind: 'first', result };
        },
        size: () => entries.size,
    };
}

