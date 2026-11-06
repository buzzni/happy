/** Daemon-owned policy; customer RPC callers cannot use PID aliases or fabricate liveness. */
import { z } from 'zod';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
    function read() {
        if (indeterminate) throw Error('RETENTION_STORE_UNAVAILABLE');
        try {
            return existsSync(file) ? fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
                : { version: 1 as const, sessions: {} as Record<string, RetentionRecord> };
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
            policy: record?.policy ?? { mode: 'default' as const }, configuredAt: record?.configuredAt ?? 0,
            revision: record?.revision ?? 0, processState: 'running' as const };
    }
    return {
        record(sessionId: string) { return read().sessions[sessionId]; },
        async get(raw: unknown) {
            const { sessionId } = getSchema.parse(raw); running(sessionId);
            return snapshot(sessionId, read().sessions[sessionId]);
        },
        async set(raw: unknown) {
            const { sessionId, policy, expectedRevision } = setSchema.parse(raw); running(sessionId);
            const store = read(), previous = store.sessions[sessionId];
            if ((previous?.revision ?? 0) !== expectedRevision) throw Error('RETENTION_CONFLICT');
            if (!previous && Object.keys(store.sessions).length >= 10000) throw Error('RETENTION_CAPACITY');
            const record = { policy, configuredAt: now(), revision: expectedRevision + 1 };
            store.sessions[sessionId] = record;
            mkdirSync(deps.home, { recursive: true, mode: 0o700 });
            const temp = `${file}.${randomUUID()}.tmp`;
            try {
                const fd = openSync(temp, 'wx', 0o600);
                try { writeFileSync(fd, JSON.stringify(store)); fsyncSync(fd); } finally { closeSync(fd); }
                renameSync(temp, file);
                if (process.platform !== 'win32') {
                    const directory = openSync(deps.home, 'r');
                    try { fsyncSync(directory); } finally { closeSync(directory); }
                }
            } catch {
                indeterminate = true;
                throw Error('RETENTION_STORE_UNAVAILABLE');
            } finally { try { unlinkSync(temp); } catch { /* already committed */ } }
            return snapshot(sessionId, record);
        },
    };
}
export type SessionRetention = ReturnType<typeof createSessionRetention>;
