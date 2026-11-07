import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendPushNotifications } from './pushSend';

function hangUntilAborted(_url: string, init: RequestInit) {
    return new Promise<Response>((_resolve, reject) => {
        // Like real fetch: an already-aborted signal rejects immediately.
        if (init.signal?.aborted) {
            reject(init.signal.reason);
            return;
        }
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
}

describe('sendPushNotifications deadline', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('gives up on a hanging Expo request and reports every message as timed out', async () => {
        const fetchMock = vi.fn(hangUntilAborted);
        vi.stubGlobal('fetch', fetchMock);

        const tickets = await sendPushNotifications([{ to: 'a' }, { to: 'b' }], { timeoutMs: 20 });

        expect(tickets).toEqual([
            { status: 'error', message: 'Timeout' },
            { status: 'error', message: 'Timeout' },
        ]);
    });

    it('shares one deadline across batches instead of restarting it per batch', async () => {
        const fetchMock = vi.fn(hangUntilAborted);
        vi.stubGlobal('fetch', fetchMock);
        const messages = Array.from({ length: 150 }, (_, i) => ({ to: `token-${i}` }));

        const started = Date.now();
        const tickets = await sendPushNotifications(messages, { timeoutMs: 50 });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][1].signal).toBe(fetchMock.mock.calls[1][1].signal);
        expect(Date.now() - started).toBeLessThan(500);
        expect(tickets).toHaveLength(150);
        expect(tickets.every(t => t.status === 'error' && t.message === 'Timeout')).toBe(true);
    });

    it('still reports a plain network failure as a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

        const tickets = await sendPushNotifications([{ to: 'a' }]);

        expect(tickets).toEqual([{ status: 'error', message: 'Network error' }]);
    });
});
