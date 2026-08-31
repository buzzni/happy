import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
    sessionFindFirst: vi.fn(),
    providerUsageEventUpsert: vi.fn(),
    usageDeliveryOutboxUpsert: vi.fn(),
    transaction: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        session: { findFirst: storage.sessionFindFirst },
        providerUsageEvent: { upsert: storage.providerUsageEventUpsert },
        usageDeliveryOutbox: { upsert: storage.usageDeliveryOutboxUpsert },
        $transaction: storage.transaction,
    },
}));

vi.mock('@/app/events/eventRouter', () => ({
    buildUsageEphemeral: vi.fn(),
    eventRouter: { emitEphemeral: vi.fn() },
}));
vi.mock('@/app/events/persistSessionEvent', () => ({ persistSessionEvent: vi.fn() }));

import { usageHandler } from './usageHandler';

const providerEvent = {
    source: 'happy-cli',
    sourceEventId: 'session-1:anthropic:msg-1',
    schemaVersion: 1,
    occurredAt: 1_788_000_000_000,
    sessionId: 'session-1',
    provider: 'anthropic',
    agent: 'claude',
    model: 'claude-sonnet-4-5',
    measurement: 'delta',
    tokens: {
        input: 100,
        output: 20,
        cacheRead: 300,
        cacheWrite: 40,
        reasoning: 0,
        total: 460,
    },
    cost: null,
    quality: 'exact',
} as const;

describe('provider-usage-report socket handler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storage.sessionFindFirst.mockResolvedValue({ id: 'session-1' });
        storage.providerUsageEventUpsert.mockResolvedValue({ id: 'event-1' });
        storage.usageDeliveryOutboxUpsert.mockResolvedValue({ id: 'outbox-1' });
        storage.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
            providerUsageEvent: { upsert: storage.providerUsageEventUpsert },
            usageDeliveryOutbox: { upsert: storage.usageDeliveryOutboxUpsert },
        }));
    });

    it('stores an immutable account-scoped event and creates its outbox atomically', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        usageHandler('account-1', socket as never);
        const callback = vi.fn();

        await handlers.get('provider-usage-report')!(providerEvent, callback);

        expect(storage.sessionFindFirst).toHaveBeenCalledWith({
            where: { id: 'session-1', accountId: 'account-1' },
            select: { id: true },
        });
        expect(storage.providerUsageEventUpsert).toHaveBeenCalledWith({
            where: {
                source_sourceEventId: {
                    source: 'happy-cli',
                    sourceEventId: 'session-1:anthropic:msg-1',
                },
            },
            update: {},
            create: {
                accountId: 'account-1',
                sessionId: 'session-1',
                source: 'happy-cli',
                sourceEventId: 'session-1:anthropic:msg-1',
                occurredAt: new Date(1_788_000_000_000),
                data: { ...providerEvent, happyAccountId: 'account-1' },
            },
        });
        expect(storage.usageDeliveryOutboxUpsert).toHaveBeenCalledWith({
            where: { usageEventId: 'event-1' },
            update: {},
            create: { usageEventId: 'event-1', nextAttemptAt: expect.any(Date) },
        });
        expect(callback).toHaveBeenCalledWith({ success: true, eventId: 'event-1' });
    });

    it('rejects malformed token totals before touching the database', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        usageHandler('account-1', socket as never);
        const callback = vi.fn();

        await handlers.get('provider-usage-report')!({
            ...providerEvent,
            tokens: { ...providerEvent.tokens, total: 999 },
        }, callback);

        expect(callback).toHaveBeenCalledWith({ success: false, error: 'Invalid provider usage event' });
        expect(storage.sessionFindFirst).not.toHaveBeenCalled();
        expect(storage.transaction).not.toHaveBeenCalled();
    });

    it('rejects a session owned by another Happy account', async () => {
        storage.sessionFindFirst.mockResolvedValue(null);
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        usageHandler('account-1', socket as never);
        const callback = vi.fn();

        await handlers.get('provider-usage-report')!(providerEvent, callback);

        expect(callback).toHaveBeenCalledWith({ success: false, error: 'Session not found' });
        expect(storage.transaction).not.toHaveBeenCalled();
    });

    it('reports a storage failure even when it happens during session ownership lookup', async () => {
        storage.sessionFindFirst.mockRejectedValue(new Error('database unavailable'));
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        usageHandler('account-1', socket as never);
        const callback = vi.fn();

        await handlers.get('provider-usage-report')!(providerEvent, callback);

        expect(callback).toHaveBeenCalledWith({
            success: false,
            error: 'Failed to persist provider usage event',
        });
        expect(storage.transaction).not.toHaveBeenCalled();
    });
});
