import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
    sessionFindFirst: vi.fn(),
    providerUsageEventUpsert: vi.fn(),
    usageDeliveryOutboxUpsert: vi.fn(),
    transaction: vi.fn(),
    usageReportUpsert: vi.fn(),
}));

const events = vi.hoisted(() => ({
    buildUsageEphemeral: vi.fn(),
    emitEphemeral: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        session: { findFirst: storage.sessionFindFirst },
        providerUsageEvent: { upsert: storage.providerUsageEventUpsert },
        usageDeliveryOutbox: { upsert: storage.usageDeliveryOutboxUpsert },
        usageReport: { upsert: storage.usageReportUpsert },
        $transaction: storage.transaction,
    },
}));

vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    events.buildUsageEphemeral.mockImplementation(actual.buildUsageEphemeral);
    return { ...actual, buildUsageEphemeral: events.buildUsageEphemeral, eventRouter: { emitEphemeral: events.emitEphemeral } };
});
vi.mock('@/app/events/persistSessionEvent', () => ({ persistSessionEvent: vi.fn(async () => undefined) }));

import { usageHandler } from './usageHandler';
import { ApiEphemeralUpdateSchema, ApiEphemeralUsageUpdateSchema } from '../../../../../happy-app/sources/sync/apiTypes';

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
        storage.usageReportUpsert.mockResolvedValue({ id: 'report-1', createdAt: new Date(1), updatedAt: new Date(2) });
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
        expect(events.emitEphemeral).not.toHaveBeenCalled();
    });

    it('relays canonical Codex usage with stable identity and unknown cost', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        usageHandler('account-1', socket as never);
        const codexEvent = {
            ...providerEvent,
            sourceEventId: 'session-1:openai:response-1',
            provider: 'openai',
            agent: 'codex',
            model: 'gpt-5.5',
            tokens: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, reasoning: 10, total: 470 },
        } as const;

        const callback = vi.fn();
        await handlers.get('provider-usage-report')!(codexEvent, callback);
        expect(callback).toHaveBeenCalledExactlyOnceWith({ success: true, eventId: 'event-1' });

        expect(events.buildUsageEphemeral).toHaveBeenCalledWith(
            'session-1',
            'provider-session',
            { total: 470, input: 100, output: 20, cache_read: 300, cache_creation: 40 },
            null,
            'session-1:openai:response-1',
        );
        expect(events.emitEphemeral).toHaveBeenCalledWith({
            userId: 'account-1',
            payload: {
                type: 'usage', id: 'session-1', key: 'provider-session',
                tokens: { total: 470, input: 100, output: 20, cache_read: 300, cache_creation: 40 },
                cost: null, sourceEventId: 'session-1:openai:response-1', timestamp: expect.any(Number),
            },
            recipientFilter: { type: 'user-scoped-only' },
        });
        const parsed = ApiEphemeralUsageUpdateSchema.parse(events.emitEphemeral.mock.calls[0][0].payload);
        expect(parsed.sourceEventId).toBe(codexEvent.sourceEventId);
        expect(parsed.tokens.cache_creation).toBe(40);
        expect(parsed.cost).toBeNull();
        expect(ApiEphemeralUpdateSchema.parse(events.emitEphemeral.mock.calls[0][0].payload)).toEqual(parsed);
    });

    it('acknowledges durable usage even if the optional UI relay fails', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        usageHandler('account-1', socket as never);
        events.emitEphemeral.mockImplementationOnce(() => { throw new Error('socket offline'); });
        const callback = vi.fn();
        await handlers.get('provider-usage-report')!({ ...providerEvent,
            provider: 'openai', agent: 'codex', sourceEventId: 'session-1:openai:response-2',
        }, callback);
        expect(storage.providerUsageEventUpsert).toHaveBeenCalledOnce();
        expect(storage.usageDeliveryOutboxUpsert).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledExactlyOnceWith({ success: true, eventId: 'event-1' });
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

describe('usage-report socket handler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storage.sessionFindFirst.mockResolvedValue({ id: 'session-1' });
        storage.usageReportUpsert.mockResolvedValue({ id: 'report-1', createdAt: new Date(1), updatedAt: new Date(2) });
    });

    it('relays an optional stable source event id without requiring it from legacy clients', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        usageHandler('account-1', socket as never);
        const base = {
            key: 'claude-session',
            sessionId: 'session-1',
            tokens: { total: 460, input: 100, output: 20, cache_creation: 40, cache_read: 300 },
            cost: { total: 0, input: 0, output: 0 },
        };

        const identifiedAck = vi.fn();
        const legacyAck = vi.fn();
        await handlers.get('usage-report')!({ ...base, sourceEventId: 'session-1:anthropic:msg-1' }, identifiedAck);
        await handlers.get('usage-report')!(base, legacyAck);
        for (const ack of [identifiedAck, legacyAck]) {
            expect(ack).toHaveBeenCalledExactlyOnceWith({ success: true, reportId: 'report-1', createdAt: 1, updatedAt: 2 });
        }

        expect(events.buildUsageEphemeral).toHaveBeenNthCalledWith(
            1, 'session-1', 'claude-session', base.tokens, base.cost, 'session-1:anthropic:msg-1',
        );
        expect(events.buildUsageEphemeral).toHaveBeenNthCalledWith(
            2, 'session-1', 'claude-session', base.tokens, base.cost, undefined,
        );
        const identified = ApiEphemeralUsageUpdateSchema.parse(events.emitEphemeral.mock.calls[0][0].payload);
        const legacy = ApiEphemeralUsageUpdateSchema.parse(events.emitEphemeral.mock.calls[1][0].payload);
        expect(identified.sourceEventId).toBe('session-1:anthropic:msg-1');
        expect(legacy.sourceEventId).toBeUndefined();
        expect(legacy.tokens).toEqual(base.tokens);
        expect(legacy.cost).toEqual(base.cost);
    });
});
