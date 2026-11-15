import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsageEventV1 } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { ProviderUsageDelivery } from './providerUsageDelivery';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

type Ack = (error: Error | null, response?: unknown) => void;

const usageEvent = (id: string) => ({ sourceEventId: `session:anthropic:${id}` }) as ProviderUsageEventV1;
const STORED = { success: true, eventId: 'stored' };
const STORAGE_FAILED = { success: false, error: 'Failed to persist provider usage event' };
const REFUSED = { success: false, error: 'Invalid provider usage event' };

function harness() {
    const link = { connected: true };
    const sent: Array<{ id: string; ack: Ack }> = [];
    const delivery = new ProviderUsageDelivery({
        isConnected: () => link.connected,
        emit: (event, ack) => { sent.push({ id: event.sourceEventId, ack }); },
    });
    return {
        link, sent, delivery,
        sentIds: () => sent.map(({ id }) => id),
        warnings: () => vi.mocked(logger.warn).mock.calls,
    };
}

describe('ProviderUsageDelivery', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.mocked(logger.warn).mockClear(); });
    afterEach(() => { vi.useRealTimers(); });

    it('retries persistence without duplicating an in-flight live send and accepts its ACK', async () => {
        const put = vi.fn().mockImplementationOnce(() => { throw new Error('disk full'); });
        const remove = vi.fn(); const sent: Ack[] = [];
        const delivery = new ProviderUsageDelivery({ isConnected: () => true, emit: (_event, ack) => { sent.push(ack); } }, { load: () => [], put, remove });
        delivery.send(usageEvent('disk'));
        expect(sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(put).toHaveBeenCalledTimes(2); expect(sent).toHaveLength(1);
        sent[0](null, STORED);
        await vi.advanceTimersByTimeAsync(60000);
        expect(delivery.unconfirmedIds()).toEqual([]); expect(put).toHaveBeenCalledTimes(2);
        await delivery.close();
    });
    it('accepts a live ACK even when disk never recovers', async () => {
        const put = vi.fn(() => { throw new Error('disk full'); });
        const delivery = new ProviderUsageDelivery({ isConnected: () => true, emit: (_event, ack) => ack(null, STORED) }, { load: () => [], put, remove: vi.fn() });
        delivery.send(usageEvent('disk'));
        expect(delivery.unconfirmedIds()).toEqual([]);
        await vi.advanceTimersByTimeAsync(60000); expect(put).toHaveBeenCalledTimes(1);
        await delivery.close();
    });
    it('identifies never-persisted events separately from durable events at close', async () => {
        const delivery = new ProviderUsageDelivery({ isConnected: () => false, emit: vi.fn() }, {
            load: () => [usageEvent('saved')], put: () => { throw new Error('disk full'); }, remove: vi.fn(),
        });
        delivery.send(usageEvent('lost')); await delivery.close();
        expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('never-persisted'), expect.objectContaining({
            count: 2, neverPersistedCount: 1, neverPersistedSourceEventIds: ['session:anthropic:lost'],
        }));
    });

    it('forgets an event only when the server confirms it stored it', () => {
        const { delivery, sent } = harness();
        delivery.send(usageEvent('a'));
        expect(delivery.unconfirmedIds()).toEqual(['session:anthropic:a']);

        sent[0].ack(null, STORED);
        expect(delivery.unconfirmedIds()).toEqual([]);
    });

    it('keeps an event that was reported while disconnected and sends it on reconnect', () => {
        const { delivery, link, sentIds } = harness();
        link.connected = false;
        delivery.send(usageEvent('a'));
        expect(sentIds()).toEqual([]);

        link.connected = true;
        delivery.resume();
        expect(sentIds()).toEqual(['session:anthropic:a']);
    });

    it('does not send an event again while an answer for it is still owed', async () => {
        const { delivery, sent, sentIds } = harness();
        delivery.send(usageEvent('a'));
        delivery.send(usageEvent('b'));
        sent[1].ack(new Error('operation has timed out'));

        delivery.resume();
        await vi.advanceTimersByTimeAsync(60_000);
        // `a` is still out; only `b`, which was answered, went again — by the reconnect, not twice.
        expect(sentIds()).toEqual(['session:anthropic:a', 'session:anthropic:b', 'session:anthropic:b']);
    });

    it.each([
        ['no answer', (ack: Ack) => ack(new Error('operation has timed out'))],
        ['a storage failure', (ack: Ack) => ack(null, STORAGE_FAILED)],
        ['an answer it cannot read', (ack: Ack) => ack(null, 'ok')],
    ])('retries after %s, waiting longer each time', async (_name, fail) => {
        const { delivery, sent, sentIds } = harness();
        delivery.send(usageEvent('a'));
        fail(sent[0].ack);
        await vi.advanceTimersByTimeAsync(999);
        expect(sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toHaveLength(2);

        fail(sent[1].ack);
        await vi.advanceTimersByTimeAsync(1999);
        expect(sent).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(sentIds()).toEqual(Array(3).fill('session:anthropic:a'));

        sent[2].ack(null, STORED);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sent).toHaveLength(3);
        expect(delivery.unconfirmedIds()).toEqual([]);
    });

    it('stops retrying at the limit without dropping the event, and says so once', async () => {
        const { delivery, sent, warnings } = harness();
        delivery.send(usageEvent('a'));
        for (let attempt = 0; attempt < 5; attempt += 1) {
            sent.at(-1)!.ack(new Error('operation has timed out'));
            await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(sent).toHaveLength(5);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(sent).toHaveLength(5);
        expect(delivery.unconfirmedIds()).toEqual(['session:anthropic:a']);
        expect(warnings()).toEqual([[expect.stringContaining('retry limit'), { sourceEventId: 'session:anthropic:a', attempts: 5 }]]);
    });

    it('gives an event past the retry limit another round once the server stores something again', async () => {
        const { delivery, sent, sentIds } = harness();
        delivery.send(usageEvent('a'));
        for (let attempt = 0; attempt < 5; attempt += 1) {
            sent.at(-1)!.ack(new Error('operation has timed out'));
            await vi.advanceTimersByTimeAsync(30_000);
        }
        delivery.send(usageEvent('b'));
        sent.at(-1)!.ack(null, STORED);
        expect(sentIds().slice(5)).toEqual(['session:anthropic:b', 'session:anthropic:a']);

        sent.at(-1)!.ack(null, STORED);
        expect(delivery.unconfirmedIds()).toEqual([]);
    });

    it('keeps a refused event unconfirmed, says so, and asks again only on a new connection', async () => {
        const { delivery, sent, warnings } = harness();
        delivery.send(usageEvent('a'));
        sent[0].ack(null, REFUSED);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(sent).toHaveLength(1);
        expect(delivery.unconfirmedIds()).toEqual(['session:anthropic:a']);
        expect(warnings()).toEqual([[expect.stringContaining('refused'),
            { sourceEventId: 'session:anthropic:a', error: 'Invalid provider usage event' }]]);

        delivery.resume();
        expect(sent).toHaveLength(2);
        sent[1].ack(null, STORED);
        expect(delivery.unconfirmedIds()).toEqual([]);
    });

    it('treats a second report of an unconfirmed event as one event, confirmed by either answer', async () => {
        const { delivery, sent, warnings } = harness();
        delivery.send(usageEvent('a'));
        delivery.send(usageEvent('a'));
        expect(delivery.unconfirmedIds()).toEqual(['session:anthropic:a']);

        sent[1].ack(null, STORED);
        // The other answer comes late and says no: the event is stored, so there is nothing to say or redo.
        sent[0].ack(null, REFUSED);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(sent).toHaveLength(2);
        expect(delivery.unconfirmedIds()).toEqual([]);
        expect(warnings()).toEqual([]);
    });

    describe('close', () => {
        it('returns at once when nothing is unconfirmed', async () => {
            const { delivery, sent, warnings } = harness();
            delivery.send(usageEvent('a'));
            sent[0].ack(null, STORED);

            let closed = false;
            void delivery.close().then(() => { closed = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(closed).toBe(true);
            expect(warnings()).toEqual([]);
        });

        it('waits for an owed answer, and for an event waiting on its retry sends it once more', async () => {
            const { delivery, sent, warnings } = harness();
            delivery.send(usageEvent('a'));
            delivery.send(usageEvent('b'));
            sent[1].ack(null, STORAGE_FAILED);

            let closed = false;
            void delivery.close().then(() => { closed = true; });
            await vi.advanceTimersByTimeAsync(1000);
            expect(sent.map(({ id }) => id)).toEqual(['session:anthropic:a', 'session:anthropic:b', 'session:anthropic:b']);
            expect(closed).toBe(false);

            sent[0].ack(null, STORED);
            sent[2].ack(null, STORED);
            await vi.advanceTimersByTimeAsync(0);
            expect(closed).toBe(true);
            expect(warnings()).toEqual([]);
        });

        it('gives up after its bound and reports what it leaves unconfirmed, by reason', async () => {
            const { delivery, sent, warnings } = harness();
            delivery.send(usageEvent('refused'));
            sent[0].ack(null, REFUSED);
            delivery.send(usageEvent('silent'));
            vi.mocked(logger.warn).mockClear();

            let closed = false;
            void delivery.close().then(() => { closed = true; });
            await vi.advanceTimersByTimeAsync(1999);
            expect(closed).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(closed).toBe(true);
            // The refused event was not asked again, and an answer that comes after the close retries nothing.
            sent[1].ack(new Error('operation has timed out'));
            await vi.advanceTimersByTimeAsync(600_000);
            expect(sent).toHaveLength(2);
            expect(warnings()).toEqual([[expect.stringContaining('unconfirmed at close'), {
                count: 2,
                neverPersistedCount: 2,
                neverPersistedSourceEventIds: ['session:anthropic:refused', 'session:anthropic:silent'],
                reasons: { 'refused: Invalid provider usage event': 1, unanswered: 1 },
                sourceEventIds: ['session:anthropic:refused', 'session:anthropic:silent'],
            }]]);
        });

        it.each([
            ['never sent', false],
            ['sent on a connection that is gone', true],
        ])('does not wait for an event %s when it cannot reach the server, and still reports', async (_name, sentBefore) => {
            const { delivery, link, warnings } = harness();
            link.connected = sentBefore;
            delivery.send(usageEvent('a'));
            link.connected = false;

            let closed = false;
            void delivery.close().then(() => { closed = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(closed).toBe(true);
            expect(warnings()).toEqual([[expect.stringContaining('unconfirmed at close'),
                { count: 1, reasons: { unanswered: 1 }, sourceEventIds: ['session:anthropic:a'], neverPersistedCount: 1, neverPersistedSourceEventIds: ['session:anthropic:a'] }]]);
        });
    });
});
