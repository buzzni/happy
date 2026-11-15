import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { createPrismaUsageOutboxRepository, deliverUsageOutboxBatch, startUsageOutboxWorker, type UsageOutboxRepository } from './usageOutbox';

vi.mock('@/storage/db', () => ({ db: { usageDeliveryOutbox: { findMany: vi.fn(), updateMany: vi.fn() } } }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

const event = {
    source: 'happy-cli',
    sourceEventId: 'session-1:anthropic:msg-1',
    schemaVersion: 1,
    occurredAt: 1_788_000_000_000,
    happyAccountId: 'account-1',
    sessionId: 'session-1',
    provider: 'anthropic',
    agent: 'claude',
    model: 'claude-sonnet-4-5',
    measurement: 'delta',
    tokens: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, reasoning: 0, total: 460 },
    cost: null,
    quality: 'exact',
} as const;

function repository(): UsageOutboxRepository & {
    claimDue: ReturnType<typeof vi.fn>;
    markDelivered: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
} {
    return {
        claimDue: vi.fn()
            .mockResolvedValueOnce([{ id: 'outbox-1', attemptCount: 0, event }])
            .mockResolvedValue([]),
        markDelivered: vi.fn().mockResolvedValue(true),
        markFailed: vi.fn().mockResolvedValue(true),
    };
}

describe('deliverUsageOutboxBatch', () => {
    it('claims an unsupported stored event without aborting the repository batch', async () => {
        vi.mocked(db.usageDeliveryOutbox.findMany).mockResolvedValue([
            { id: 'bad', attemptCount: 0, usageEvent: { data: { schemaVersion: 2 } } },
        ] as any);
        vi.mocked(db.usageDeliveryOutbox.updateMany).mockResolvedValue({ count: 1 });
        const result = await createPrismaUsageOutboxRepository().claimDue(new Date(0), new Date(30000), 1);
        expect(result).toEqual([{ id: 'bad', attemptCount: 0, event: { schemaVersion: 2 } }]);
    });

    it.each([
        { ...event, schemaVersion: 2 },
        { ...event, tokens: { ...event.tokens, total: -1 } },
        { ...event, unexpected: 'private-content' },
    ])('retains an invalid event for retry and delivers the following valid event (%#)', async (invalid) => {
        const repo = repository();
        repo.claimDue.mockReset()
            .mockResolvedValueOnce([{ id: 'bad', attemptCount: 0, event: invalid }])
            .mockResolvedValueOnce([{ id: 'good', attemptCount: 0, event }])
            .mockResolvedValue([]);
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
        const now = new Date('2026-08-31T04:00:00Z');
        const result = await deliverUsageOutboxBatch({ repository: repo, fetchImpl,
            endpoint: 'https://saycode.test/usage', secret: 'test', now });
        expect(result).toEqual({ claimed: 2, delivered: 1, failed: 0, invalid: 1, leaseLost: 0 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(repo.markFailed).toHaveBeenCalledWith('bad', new Date(now.getTime() + 30000),
            1, new Date(now.getTime() + 60000), 'invalid-usage-event');
        expect(repo.markDelivered).toHaveBeenCalledWith('good', new Date(now.getTime() + 30000), now);
    });

    it('signs the normalized event it validated, not the stored JSON, and marks a successful delivery', async () => {
        const repo = repository();
        // Stored JSON the schema accepts but normalizes: the receiver must get what was validated.
        const stored = { ...event, sourceEventId: ' session-1:anthropic:msg-1 ', model: ' claude-sonnet-4-5 ' };
        repo.claimDue.mockReset()
            .mockResolvedValueOnce([{ id: 'outbox-1', attemptCount: 0, event: stored }])
            .mockResolvedValue([]);
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
        const now = new Date('2026-08-31T04:00:00.000Z');

        const result = await deliverUsageOutboxBatch({
            repository: repo,
            fetchImpl,
            endpoint: 'https://saycode.test/api/internal/ai-usage/events',
            secret: 'test-secret',
            now,
        });

        const [endpoint, init] = fetchImpl.mock.calls[0]!;
        expect(endpoint).toBe('https://saycode.test/api/internal/ai-usage/events');
        expect(JSON.parse(init.body)).toEqual(event);
        const timestamp = String(Math.floor(now.getTime() / 1000));
        const signature = createHmac('sha256', 'test-secret')
            .update(`${timestamp}.${init.body}`)
            .digest('hex');
        expect(init).toEqual({
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-saycode-usage-event-id': 'session-1:anthropic:msg-1',
                'x-saycode-usage-signature': `v1=${signature}`,
                'x-saycode-usage-timestamp': timestamp,
            },
            body: init.body,
            signal: expect.any(AbortSignal),
        });
        expect(repo.markDelivered).toHaveBeenCalledWith(
            'outbox-1',
            new Date(now.getTime() + 30_000),
            now,
        );
        expect(repo.markFailed).not.toHaveBeenCalled();
        expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0, invalid: 0, leaseLost: 0 });
    });

    it('counts an invalid event whose lease was taken over as a lost lease, not as retained', async () => {
        const repo = repository();
        repo.claimDue.mockReset()
            .mockResolvedValueOnce([{ id: 'bad', attemptCount: 0, event: { ...event, schemaVersion: 2 } }])
            .mockResolvedValue([]);
        repo.markFailed.mockResolvedValue(false);
        const fetchImpl = vi.fn();

        const result = await deliverUsageOutboxBatch({ repository: repo, fetchImpl,
            endpoint: 'https://saycode.test/usage', secret: 'test', now: new Date('2026-08-31T04:00:00Z') });

        expect(result).toEqual({ claimed: 1, delivered: 0, failed: 0, invalid: 0, leaseLost: 1 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'an event this worker cannot validate', item: { ...event, schemaVersion: 2 }, fetchOk: true,
            expected: 'Usage delivery batch kept 1 event(s) this worker cannot validate', other: 'retryable failure' },
        { name: 'a delivery failure', item: event, fetchOk: false,
            expected: 'Usage delivery batch had 1 retryable failure(s)', other: 'cannot validate' },
    ])('logs $name apart from the other kind', async ({ item, fetchOk, expected, other }) => {
        vi.mocked(log).mockClear();
        const repo = repository();
        repo.claimDue.mockReset()
            .mockResolvedValueOnce([{ id: 'outbox-1', attemptCount: 0, event: item }])
            .mockResolvedValue([]);
        const worker = startUsageOutboxWorker({ endpoint: 'https://saycode.test/usage', secret: 'test',
            repository: repo, fetchImpl: vi.fn().mockResolvedValue({ ok: fetchOk, status: fetchOk ? 202 : 503 }) });
        try {
            await vi.waitFor(() => expect(repo.markFailed).toHaveBeenCalledTimes(1));
            await vi.waitFor(() => expect(vi.mocked(log).mock.calls.map(([, message]) => message)).toContain(expected));
            expect(vi.mocked(log).mock.calls.some(([, message]) => String(message).includes(other))).toBe(false);
        } finally {
            worker.stop();
        }
    });

    it('returns the row to pending with exponential backoff after an HTTP failure', async () => {
        const repo = repository();
        const now = new Date('2026-08-31T04:00:00.000Z');

        const result = await deliverUsageOutboxBatch({
            repository: repo,
            fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
            endpoint: 'https://saycode.test/api/internal/ai-usage/events',
            secret: 'test-secret',
            now,
        });

        expect(repo.markFailed).toHaveBeenCalledWith(
            'outbox-1',
            new Date(now.getTime() + 30_000),
            1,
            new Date(now.getTime() + 60_000),
            'HTTP 503',
        );
        expect(repo.markDelivered).not.toHaveBeenCalled();
        expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1, invalid: 0, leaseLost: 0 });
    });

    it('keeps a network exception retryable without leaking arbitrary response content', async () => {
        const repo = repository();
        const now = new Date('2026-08-31T04:00:00.000Z');

        await deliverUsageOutboxBatch({
            repository: repo,
            fetchImpl: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED with secret body')),
            endpoint: 'https://saycode.test/api/internal/ai-usage/events',
            secret: 'test-secret',
            now,
        });

        expect(repo.markFailed).toHaveBeenCalledWith(
            'outbox-1',
            new Date(now.getTime() + 30_000),
            1,
            new Date(now.getTime() + 60_000),
            'network-error',
        );
    });

    it('does not let a stale worker overwrite a newer lease owner', async () => {
        const repo = repository();
        repo.markDelivered.mockResolvedValue(false);
        const now = new Date('2026-08-31T04:00:00.000Z');

        const result = await deliverUsageOutboxBatch({
            repository: repo,
            fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 202 }),
            endpoint: 'https://saycode.test/api/internal/ai-usage/events',
            secret: 'test-secret',
            now,
        });

        expect(result).toEqual({ claimed: 1, delivered: 0, failed: 0, invalid: 0, leaseLost: 1 });
        expect(repo.markFailed).not.toHaveBeenCalled();
    });

    it('aborts a hung request before the lease expires and keeps it retryable', async () => {
        const repo = repository();
        const now = new Date('2026-08-31T04:00:00.000Z');
        const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => (
            new Promise<{ ok: boolean; status: number }>((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')))
            })
        ));

        const result = await deliverUsageOutboxBatch({
            repository: repo,
            fetchImpl,
            endpoint: 'https://saycode.test/api/internal/ai-usage/events',
            secret: 'test-secret',
            now,
            requestTimeoutMs: 1,
        });

        expect(repo.markFailed).toHaveBeenCalledWith(
            'outbox-1',
            new Date(now.getTime() + 30_000),
            1,
            new Date(now.getTime() + 60_000),
            'network-error',
        );
        expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true);
        expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1, invalid: 0, leaseLost: 0 });
    });

    it('claims and signs each item with the current time instead of the batch start time', async () => {
        vi.useFakeTimers();
        const firstNow = new Date('2026-08-31T04:00:00.000Z');
        const secondNow = new Date(firstNow.getTime() + 301_000);
        vi.setSystemTime(firstNow);
        const repo = repository();
        repo.claimDue.mockReset()
            .mockResolvedValueOnce([{ id: 'outbox-1', attemptCount: 0, event }])
            .mockResolvedValueOnce([{
                id: 'outbox-2',
                attemptCount: 0,
                event: { ...event, sourceEventId: 'session-1:anthropic:msg-2' },
            }]);
        const timestamps: string[] = [];
        const fetchImpl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
            timestamps.push(init.headers['x-saycode-usage-timestamp']);
            if (timestamps.length === 1) vi.setSystemTime(secondNow);
            return { ok: true, status: 202 };
        });

        const result = await deliverUsageOutboxBatch({
            repository: repo,
            fetchImpl,
            endpoint: 'https://saycode.test/api/internal/ai-usage/events',
            secret: 'test-secret',
            limit: 2,
        });

        expect(timestamps).toEqual([
            String(Math.floor(firstNow.getTime() / 1000)),
            String(Math.floor(secondNow.getTime() / 1000)),
        ]);
        expect(repo.claimDue).toHaveBeenNthCalledWith(
            1,
            firstNow,
            new Date(firstNow.getTime() + 30_000),
            1,
        );
        expect(repo.claimDue).toHaveBeenNthCalledWith(
            2,
            secondNow,
            new Date(secondNow.getTime() + 30_000),
            1,
        );
        expect(result).toEqual({ claimed: 2, delivered: 2, failed: 0, invalid: 0, leaseLost: 0 });
    });
});
