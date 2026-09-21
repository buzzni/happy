import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.object({
    requestId: z.string().min(1), evidenceKey: z.string().min(1), projectId: z.string().min(1), sessionId: z.string().min(1),
    day: z.string(), createdAt: amount, state: z.enum(['reserved', 'settled', 'unknown']),
    microUsd: amount, tokens: amount, execution: z.literal('session').optional(),
});
type Entry = z.infer<typeof entrySchema>;
const ledgerSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
export interface ReviewReservation {
    requestId: string; evidenceKey: string; projectId: string; sessionId: string;
    reserveMicroUsd: number; reserveTokens: number; dailyMicroUsd: number; dailyTokens: number; cooldownMs: number;
}
export type ReviewBudgetResult = { ok: true } | { ok: false; reason: 'busy' | 'duplicate' | 'cooldown' | 'usage_unknown' | 'budget_exceeded' | 'invalid_budget' | 'storage_error' };

/** One machine-wide ledger, shared by projects. Unknown charges survive restart/day rollover. */
export class LessonReviewBudget {
    constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

    private async transaction<T>(work: (entries: Entry[]) => T): Promise<T> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        // Never steal a lock by guessing process liveness. A crashed lock fails closed.
        const lock = await open(`${this.path}.lock`, 'wx', 0o600);
        let temp: string | undefined;
        try {
            let entries: Entry[] = [];
            try { entries = ledgerSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))).entries; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const result = work(entries);
            temp = `${this.path}.${randomUUID()}.tmp`;
            const file = await open(temp, 'wx', 0o600);
            try { await file.writeFile(JSON.stringify({ version: 1, entries })); await file.sync(); }
            finally { await file.close(); }
            await rename(temp, this.path); temp = undefined;
            return result;
        } finally {
            if (temp) await unlink(temp).catch(() => {});
            await lock.close(); await unlink(`${this.path}.lock`);
        }
    }

    /** Foreground work has already consumed the session's normal usage. This is a
     * durable rate/deduplication claim, never a fabricated price or invoice. */
    async claimSession(input: Pick<ReviewReservation, 'requestId' | 'evidenceKey' | 'projectId' | 'sessionId' | 'cooldownMs'>): Promise<ReviewBudgetResult> {
        if (!Number.isSafeInteger(input.cooldownMs) || input.cooldownMs <= 0
            || ![input.requestId, input.evidenceKey, input.projectId, input.sessionId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512)) {
            return { ok: false, reason: 'invalid_budget' };
        }
        try {
            return await this.transaction<ReviewBudgetResult>((entries) => {
                const now = this.now();
                if (entries.some(e => e.requestId === input.requestId || (e.projectId === input.projectId && e.evidenceKey === input.evidenceKey))) return { ok: false, reason: 'duplicate' };
                if (entries.some(e => e.projectId === input.projectId && e.sessionId === input.sessionId && now - e.createdAt < input.cooldownMs)) return { ok: false, reason: 'cooldown' };
                entries.push({ ...input, day: new Date(now).toISOString().slice(0, 10), createdAt: now,
                    state: 'settled', microUsd: 0, tokens: 0, execution: 'session' });
                return { ok: true };
            });
        } catch (error) { return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'storage_error' }; }
    }

    /** Release only our zero-cost claim before candidate enqueue has begun. */
    async cancelSessionClaim(requestId: string): Promise<boolean> {
        try {
            return await this.transaction(entries => {
                const index = entries.findIndex(e => e.requestId === requestId && e.execution === 'session');
                if (index < 0) return false;
                entries.splice(index, 1);
                return true;
            });
        } catch { return false; }
    }

    async reserve(input: ReviewReservation): Promise<ReviewBudgetResult> {
        if (![input.reserveMicroUsd, input.reserveTokens, input.dailyMicroUsd, input.dailyTokens, input.cooldownMs]
            .every(v => Number.isSafeInteger(v) && v > 0)
            || ![input.requestId, input.evidenceKey, input.projectId, input.sessionId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512)) {
            return { ok: false, reason: 'invalid_budget' };
        }
        try {
            return await this.transaction<ReviewBudgetResult>((entries) => {
                const now = this.now(); const day = new Date(now).toISOString().slice(0, 10);
                // No automatic refund when a worker died or a request outlived the hard deadline.
                for (const entry of entries) if (entry.state === 'reserved' && now - entry.createdAt > 32000) entry.state = 'unknown';
                if (entries.some(e => e.state === 'unknown')) return { ok: false, reason: 'usage_unknown' };
                if (entries.some(e => e.requestId === input.requestId || (e.projectId === input.projectId && e.evidenceKey === input.evidenceKey))) return { ok: false, reason: 'duplicate' };
                if (entries.some(e => e.state === 'reserved')) return { ok: false, reason: 'busy' };
                if (entries.some(e => e.projectId === input.projectId && e.sessionId === input.sessionId && now - e.createdAt < input.cooldownMs)) return { ok: false, reason: 'cooldown' };
                const daily = entries.filter(e => e.day === day);
                if (daily.reduce((n, e) => n + e.microUsd, input.reserveMicroUsd) > input.dailyMicroUsd
                    || daily.reduce((n, e) => n + e.tokens, input.reserveTokens) > input.dailyTokens) return { ok: false, reason: 'budget_exceeded' };
                entries.push({ requestId: input.requestId, evidenceKey: input.evidenceKey, projectId: input.projectId, sessionId: input.sessionId,
                    day, createdAt: now, state: 'reserved', microUsd: input.reserveMicroUsd, tokens: input.reserveTokens });
                return { ok: true };
            });
        } catch (error) { return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'storage_error' }; }
    }

    /** Only the worker may call this before handing a request to its transport. */
    async cancelUndispatched(requestId: string): Promise<boolean> {
        try {
            return await this.transaction(entries => {
                const index = entries.findIndex(e => e.requestId === requestId && e.state === 'reserved');
                if (index < 0) return false;
                entries.splice(index, 1); return true;
            });
        } catch { return false; }
    }

    /** Null is an unknown charge, never zero. Repeated settlement cannot rewrite an invoice. */
    async settle(requestId: string, usage: { microUsd: number; tokens: number } | null): Promise<boolean> {
        try {
            return await this.transaction((entries) => {
                const entry = entries.find(e => e.requestId === requestId);
                if (!entry || entry.state !== 'reserved') return false;
                if (!usage || !amount.safeParse(usage.microUsd).success || !amount.safeParse(usage.tokens).success) entry.state = 'unknown';
                else { entry.state = 'settled'; entry.microUsd = usage.microUsd; entry.tokens = usage.tokens; }
                return true;
            });
        } catch { return false; }
    }
}
