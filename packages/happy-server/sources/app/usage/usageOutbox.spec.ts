import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deliverUsageOutboxBatch, type UsageOutboxRepository } from './usageOutbox';

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
        claimDue: vi.fn().mockResolvedValue([{ id: 'outbox-1', attemptCount: 0, event }]),
        markDelivered: vi.fn().mockResolvedValue(true),
        markFailed: vi.fn().mockResolvedValue(true),
    };
}

describe('deliverUsageOutboxBatch', () => {
    it('signs the exact request body and marks a successful delivery', async () => {
        const repo = repository();
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
        const now = new Date('2026-08-31T04:00:00.000Z');

        const result = await deliverUsageOutboxBatch({
            repository: repo,
            fetchImpl,
            endpoint: 'https://saycode.test/api/internal/ai-usage/events',
            secret: 'test-secret',
            now,
        });

        const body = JSON.stringify(event);
        const timestamp = String(Math.floor(now.getTime() / 1000));
        const signature = createHmac('sha256', 'test-secret')
            .update(`${timestamp}.${body}`)
            .digest('hex');
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://saycode.test/api/internal/ai-usage/events',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-saycode-usage-event-id': 'session-1:anthropic:msg-1',
                    'x-saycode-usage-signature': `v1=${signature}`,
                    'x-saycode-usage-timestamp': timestamp,
                },
                body,
                signal: expect.any(AbortSignal),
            }),
        );
        expect(repo.markDelivered).toHaveBeenCalledWith(
            'outbox-1',
            new Date(now.getTime() + 30_000),
            now,
        );
        expect(repo.markFailed).not.toHaveBeenCalled();
        expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0, leaseLost: 0 });
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
        expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1, leaseLost: 0 });
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

        expect(result).toEqual({ claimed: 1, delivered: 0, failed: 0, leaseLost: 1 });
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
        expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1, leaseLost: 0 });
    });
});
