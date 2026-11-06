/** Daemon-owned policy; customer RPC callers cannot use PID aliases or fabricate liveness. */
import { z } from 'zod';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionRuntimeState, TrackedSession } from './types';

const duration = z.union([z.literal(3600000), z.literal(14400000), z.literal(28800000), z.literal(86400000)]);
export const retentionPolicySchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('default') }).strict(),
    z.object({ mode: z.literal('idle'), durationMs: duration }).strict(),
    z.object({ mode: z.literal('keep-alive') }).strict(),
]);
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
const recordSchema = z.object({ policy: retentionPolicySchema, configuredAt: z.number().int().nonnegative(), revision: z.number().int().positive() }).strict();
export type RetentionRecord = z.infer<typeof recordSchema>;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !value.startsWith('PID-'));
const getSchema = z.object({ sessionId: id }).strict();
const setSchema = getSchema.extend({ policy: retentionPolicySchema, expectedRevision: z.number().int().nonnegative() }).strict();
const fileSchema = z.object({ version: z.literal(1), sessions: z.record(id, recordSchema) }).strict();
type RetentionStore = z.infer<typeof fileSchema>;

export function retentionProtects(record: RetentionRecord | undefined,
    runtime: Pick<Partial<SessionRuntimeState>, 'lastUserInteractionAt' | 'lastTurnEndAt' | 'updatedAt'> | undefined, now: number): boolean {
    if (!record || record.policy.mode === 'default') return false;
    if (record.policy.mode === 'keep-alive') return true;
    return now - Math.max(record.configuredAt, runtime?.lastUserInteractionAt ?? 0, runtime?.lastTurnEndAt ?? 0) < record.policy.durationMs;
}

export function createSessionRetention(deps: { home: string; children(): readonly TrackedSession[]; now?: () => number }) {
    const file = join(deps.home, 'session-retention.v1.json'), now = deps.now ?? Date.now;
    // Do not overwrite an unreadable policy or acknowledge indeterminate persistence.
    let indeterminate = false;
    let cached: { fingerprint: string; store: RetentionStore | null } | undefined;
    function read(): RetentionStore {
        if (indeterminate) throw Error('RETENTION_STORE_UNAVAILABLE');
        try {
            // Reuse validation across idle candidates, but detect replacements, edits and deletion.
            const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
            const fingerprint = stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'missing';
            if (cached?.fingerprint === fingerprint) {
                if (!cached.store) throw Error('RETENTION_STORE_UNAVAILABLE');
                return cached.store;
            }
            cached = undefined;
            // A transient I/O error is retried; deterministic validation failures are cached
            // until the file changes. Neither may fall back to a previously valid policy.
            const contents = stat ? readFileSync(file, 'utf8') : undefined;
            try {
                const store: RetentionStore = contents === undefined ? { version: 1, sessions: {} }
                    : fileSchema.parse(JSON.parse(contents));
                cached = { fingerprint, store };
                return store;
            } catch {
                cached = { fingerprint, store: null };
                throw Error('RETENTION_STORE_UNAVAILABLE');
            }
        } catch { throw Error('RETENTION_STORE_UNAVAILABLE'); }
    }
    function running(sessionId: string) {
        const child = deps.children().find(row => row.happySessionId === sessionId);
        if (!child) throw Error('RETENTION_STOPPED');
        if (!child.runtime || now() - child.runtime.updatedAt > 300000) throw Error('RETENTION_RUNTIME_UNCONFIRMED');
        return child;
    }
    function snapshot(sessionId: string, record?: RetentionRecord) {
        return { version: 1 as const, capability: 'session-retention-v1' as const, sessionId,
            policy: record ? { ...record.policy } : { mode: 'default' as const }, configuredAt: record?.configuredAt ?? 0,
            revision: record?.revision ?? 0, processState: 'running' as const };
    }
    return {
        record(sessionId: string) {
            const record = read().sessions[sessionId];
            return record ? { ...record, policy: { ...record.policy } } : undefined;
        },
        async get(raw: unknown) {
            const { sessionId } = getSchema.parse(raw); running(sessionId);
            return snapshot(sessionId, read().sessions[sessionId]);
        },
        async set(raw: unknown) {
            const { sessionId, policy, expectedRevision } = setSchema.parse(raw); running(sessionId);
            const current = read(), previous = current.sessions[sessionId];
            if ((previous?.revision ?? 0) !== expectedRevision) throw Error('RETENTION_CONFLICT');
            if (!previous && Object.keys(current.sessions).length >= 10000) throw Error('RETENTION_CAPACITY');
            const record = { policy, configuredAt: now(), revision: expectedRevision + 1 };
            // Never change the confirmed snapshot before the durable write succeeds.
            const store = { ...current, sessions: { ...current.sessions, [sessionId]: record } };
            mkdirSync(deps.home, { recursive: true, mode: 0o700 });
            const temp = `${file}.${randomUUID()}.tmp`;
            let renamed = false;
            try {
                const fd = openSync(temp, 'wx', 0o600);
                try { writeFileSync(fd, JSON.stringify(store)); fsyncSync(fd); } finally { closeSync(fd); }
                renameSync(temp, file);
                renamed = true;
                if (process.platform !== 'win32') {
                    const directory = openSync(deps.home, 'r');
                    try { fsyncSync(directory); } finally { closeSync(directory); }
                }
            } catch {
                indeterminate = renamed;
                throw Error('RETENTION_STORE_UNAVAILABLE');
            } finally { try { unlinkSync(temp); } catch { /* already committed */ } }
            cached = undefined;
            return snapshot(sessionId, record);
        },
    };
}
export type SessionRetention = ReturnType<typeof createSessionRetention>;
