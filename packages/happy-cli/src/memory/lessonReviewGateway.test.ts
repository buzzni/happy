import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonReviewBudget } from './lessonReviewBudget';
import { reviewLessonWithGateway } from './lessonReviewGateway';
const dirs: string[] = [];
const now = Date.UTC(2026, 8, 20);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lesson-review-')); dirs.push(dir);
  return {
    budget: new LessonReviewBudget(join(dir, 'ledger.json'), () => now),
    enabled: true, current: () => true, signal: new AbortController().signal,
    gateway: { baseUrl: 'https://gateway.example/v1', apiKey: 'fixture-secret', projectId: 'p' },
    identity: { userId: 'authenticated-user', projectId: 'p', sessionId: 's' },
    requestId: 'r1', evidenceKey: 'e1', evidence: 'After correcting a flaky test, isolate the clock and rerun the suite.',
    limits: { dailyMicroUsd: 100000, dailyTokens: 100000 },
    quote: { model: 'configured-default', inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 2000000, expiresAt: now + 60000, source: 'fixture-verified-catalog' },
    now: () => now,
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ model: 'configured-default', choices: [{ message: { content: '{"proposal":null}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))),
  };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('lesson review gateway boundary', () => {
  it('makes no paid call without opt-in, a fresh price, matching project and current identity', async () => {
    const f = await fixture();
    for (const overrides of [{ enabled: false }, { quote: null }, { quote: { ...f.quote, expiresAt: now } }, { identity: { ...f.identity, userId: '' } }, { gateway: { ...f.gateway, projectId: 'other' } }, { current: () => false }]) {
      expect((await reviewLessonWithGateway({ ...f, ...overrides })).ok).toBe(false);
    }
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('never sends explicitly private evidence or a private key to the model', async () => {
    const f = await fixture();
    for (const evidence of ['procedure <private>personal detail</private>', '[PRIVATE] private content', '-----BEGIN PRIVATE KEY----- fixture']) {
      expect(await reviewLessonWithGateway({ ...f, evidence })).toMatchObject({ ok: false, reason: 'private_evidence' });
    }
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('uses configured default, actual caller, bounded output and no redirect', async () => {
    const f = await fixture(); expect(await reviewLessonWithGateway(f)).toMatchObject({ ok: true, proposal: null });
    const [url, init] = (f.fetchImpl.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('https://gateway.example/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ 'X-Api-User-Id': 'authenticated-user', 'X-Project-Id': 'p' });
    expect(JSON.parse(String(init.body))).toMatchObject({ max_tokens: 1000, stream: false });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('model');
    expect((await reviewLessonWithGateway(f)).ok).toBe(false); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('unknown usage keeps its reservation and blocks retries', async () => {
    const f = await fixture(); f.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ choices: [] })));
    expect(await reviewLessonWithGateway(f)).toMatchObject({ ok: false, reason: 'usage_unknown' });
    expect(await reviewLessonWithGateway({ ...f, requestId: 'r2', evidenceKey: 'e2' })).toMatchObject({ ok: false, reason: 'usage_unknown' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rechecks price expiry after reservation before any paid dispatch', async () => {
    const f = await fixture(); let clock = now;
    const reserve = f.budget.reserve.bind(f.budget);
    vi.spyOn(f.budget, 'reserve').mockImplementation(async input => {
      const result = await reserve(input); clock = f.quote.expiresAt; return result;
    });
    expect(await reviewLessonWithGateway({ ...f, now: () => clock })).toMatchObject({ ok: false, reason: 'price_unknown' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('releases a reservation when cancelled before dispatch and allows retry', async () => {
    const f = await fixture(); let checks = 0;
    expect(await reviewLessonWithGateway({ ...f, current: () => ++checks === 1 })).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(await reviewLessonWithGateway(f)).toMatchObject({ ok: true });
  });
  it('returns promptly on cancellation even if a transport ignores its signal', async () => {
    const f = await fixture(); const controller = new AbortController(); let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl = vi.fn((_url: unknown, init: RequestInit | undefined) => {
      started(); expect(init?.signal).toBeDefined(); return new Promise<Response>(() => {});
    });
    const result = reviewLessonWithGateway({ ...f, signal: controller.signal, fetchImpl });
    await ready; controller.abort();
    expect(await result).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(await reviewLessonWithGateway({ ...f, requestId: 'r2', evidenceKey: 'e2' })).toMatchObject({ ok: false, reason: 'usage_unknown' });
  });
  it('rejects late output after revocation without refunding a measured charge', async () => {
    const f = await fixture(); let current = true;
    const fetchImpl = async () => { current = false; return f.fetchImpl(); };
    expect(await reviewLessonWithGateway({ ...f, fetchImpl, current: () => current })).toMatchObject({ ok: false, reason: 'cancelled' });
  });
});
