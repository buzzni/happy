import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonReviewBudget } from './lessonReviewBudget';
import { UNOWNED_LOCK_STALE_MS, type OwnedFileLockDeps } from '@/utils/ownedFileLock';
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lesson-budget-')); dirs.push(dir);
  return { path: join(dir, 'budget.json'), clock: () => Date.UTC(2026, 8, 20) };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const input = { requestId: 'one', evidenceKey: 'e1', projectId: 'p', sessionId: 's', reserveMicroUsd: 50, reserveTokens: 100, dailyMicroUsd: 100, dailyTokens: 200, cooldownMs: 1800000 };
describe('durable lesson review budget', () => {
  it('reserves globally once and settles exactly once, including after restart', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock);
    expect(await a.reserve(input)).toEqual({ ok: true });
    const b = new LessonReviewBudget(f.path, f.clock);
    expect(await b.reserve({ ...input, requestId: 'two', evidenceKey: 'e2', projectId: 'other' })).toEqual({ ok: false, reason: 'busy' });
    await a.settle('one', { microUsd: 20, tokens: 40 });
    expect(await b.reserve(input)).toEqual({ ok: false, reason: 'duplicate' });
    expect(await b.settle('one', { microUsd: 99, tokens: 99 })).toBe(false);
    expect(await b.reserve({ ...input, requestId: 'two', evidenceKey: 'e2' })).toEqual({ ok: false, reason: 'cooldown' });
  });
  it('unknown usage blocks later paid work even on the next day', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock);
    await a.reserve(input); await a.settle('one', null);
    const b = new LessonReviewBudget(f.path, () => f.clock() + 86400000);
    expect(await b.reserve({ ...input, requestId: 'two', evidenceKey: 'e2' })).toEqual({ ok: false, reason: 'usage_unknown' });
  });
  it('caps sum of settled and new reservations and rejects nonfinite budgets', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock);
    await a.reserve(input); await a.settle('one', { microUsd: 70, tokens: 50 });
    expect(await a.reserve({ ...input, requestId: 'two', evidenceKey: 'e2', sessionId: 's2' })).toEqual({ ok: false, reason: 'budget_exceeded' });
    expect(await a.reserve({ ...input, requestId: 'three', reserveMicroUsd: NaN })).toEqual({ ok: false, reason: 'invalid_budget' });
  });
  it('releases an undispatched reservation without blocking retry or cooldown', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock);
    await a.reserve(input);
    expect(await a.cancelUndispatched('one')).toBe(true);
    expect(await a.reserve(input)).toEqual({ ok: true });
    await a.settle('one', null);
    expect(await a.cancelUndispatched('one')).toBe(false);
  });
  it('concurrent processes cannot both reserve a slot', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock); const b = new LessonReviewBudget(f.path, f.clock);
    const results = await Promise.all([a.reserve(input), b.reserve({ ...input, requestId: 'two', evidenceKey: 'e2' })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
  });
});

 it('claims foreground proposals without a paid budget, preserving durable deduplication and cooldown', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock);
    expect(await a.claimSession(input)).toEqual({ ok: true });
    const b = new LessonReviewBudget(f.path, f.clock);
    expect(await b.claimSession(input)).toEqual({ ok: false, reason: 'duplicate' });
    expect(await b.claimSession({ ...input, requestId: 'two', evidenceKey: 'e2' })).toEqual({ ok: false, reason: 'cooldown' });
 });

 it('releases only undispatched session claims, never a paid reservation', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock);
    await a.reserve(input);
    expect(await a.cancelSessionClaim(input.requestId)).toBe(false);
    await a.cancelUndispatched(input.requestId);
    await a.claimSession(input);
    expect(await a.cancelSessionClaim(input.requestId)).toBe(true);
    expect(await a.claimSession(input)).toEqual({ ok: true });
 });

describe('ledger lock left behind', () => {
  const owner = (pid: number, startedAt: number) => JSON.stringify({ version: 1, pid, startedAt, token: randomUUID(), acquiredAt: startedAt });
  const ledgerIds = async (path: string) => JSON.parse(await readFile(path, 'utf8')).entries.map((e: { requestId: string }) => e.requestId);

  it('reclaims the lock of a holder that crashed and records the claim', async () => {
    const f = await fixture();
    const crashed = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise(resolve => crashed.once('exit', resolve));
    await writeFile(`${f.path}.lock`, owner(crashed.pid!, Date.now()));
    expect(await new LessonReviewBudget(f.path, f.clock).claimSession(input)).toEqual({ ok: true });
    expect(await ledgerIds(f.path)).toEqual(['one']);
    await expect(readFile(`${f.path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stays busy for a live holder and for a recent lock from an older version, leaving the ledger untouched', async () => {
    const f = await fixture(); const a = new LessonReviewBudget(f.path, f.clock);
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await new Promise(resolve => live.once('spawn', resolve));
      await writeFile(`${f.path}.lock`, owner(live.pid!, Date.now()));
      expect(await a.claimSession(input)).toEqual({ ok: false, reason: 'busy' });
      expect(await a.reserve(input)).toEqual({ ok: false, reason: 'busy' });
    } finally { live.kill(); }
    await writeFile(`${f.path}.lock`, '');
    expect(await a.claimSession(input)).toEqual({ ok: false, reason: 'busy' });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const old = new Date(Date.now() - UNOWNED_LOCK_STALE_MS - 60_000);
    await utimes(`${f.path}.lock`, old, old);
    expect(await a.claimSession(input)).toEqual({ ok: true });
    expect(await ledgerIds(f.path)).toEqual(['one']);
  });

  it('does not let a second claim write the ledger while the first still holds the lock', async () => {
    // A stalls right after creating the lock; B confirms it abandoned and is held before removing it;
    // A takes the lock for its own; only then does B go on.
    const f = await fixture();
    let confirmed!: () => void; let proceed!: () => void;
    const bConfirmed = new Promise<void>(resolve => { confirmed = resolve; });
    const bProceeds = new Promise<void>(resolve => { proceed = resolve; });
    const b = new LessonReviewBudget(f.path, f.clock, { log: () => {}, onReclaimConfirmed: async () => { confirmed(); await bProceeds; } });
    let second!: Promise<unknown>;
    const aDeps: OwnedFileLockDeps = {
      log: () => {},
      onLockCreated: async () => {
        const old = new Date(Date.now() - UNOWNED_LOCK_STALE_MS - 60_000);
        await utimes(`${f.path}.lock`, old, old);
        second = b.claimSession({ ...input, requestId: 'two' });
        await Promise.race([bConfirmed, second]);
      },
      onAcquired: async () => { proceed(); await second; },
    };
    expect(await new LessonReviewBudget(f.path, f.clock, aDeps).claimSession(input)).toEqual({ ok: true });
    expect(await second).toEqual({ ok: false, reason: 'busy' });
    expect(await ledgerIds(f.path)).toEqual(['one']);
  });
});
