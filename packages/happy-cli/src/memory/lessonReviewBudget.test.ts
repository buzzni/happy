import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonReviewBudget } from './lessonReviewBudget';
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
