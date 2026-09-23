import { describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import { createIsolatedRedisAdapter, RESTORE_SESSION_TIMEOUT_MS } from './createIsolatedRedisAdapter';

function redisConnection(restore: { exec: () => Promise<unknown>; xrange: () => Promise<unknown> } = {
    exec: () => new Promise(() => {}),
    xrange: () => new Promise(() => {}),
}) {
    let blocked = false;
    let unblock!: () => void;
    const pendingRead = new Promise<null>(resolve => { unblock = () => resolve(null); });
    const published: unknown[][] = [];
    const client = {
        xread: vi.fn(() => { blocked = true; return pendingRead; }),
        xadd: vi.fn(async (...args: unknown[]) => {
            if (blocked) await pendingRead;
            published.push(args);
            return '1-0';
        }),
        disconnect: vi.fn(() => unblock()),
        multi: () => ({ get() { return this; }, del() { return this; }, exec: restore.exec }),
        xrange: vi.fn(restore.xrange),
    };
    return { client: client as unknown as Redis, xread: client.xread,
        disconnect: client.disconnect, published };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('createIsolatedRedisAdapter', () => {
    it.each(['socket.io', 'socket.io.managed'])('publishes %s requests while the stream reader is blocked', async (streamName) => {
        const writer = redisConnection();
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client,
            { streamName, maxLen: 200000, readCount: 2000 }) });
        try {
            io.serverSideEmit('probe');
            await flush();
            expect(reader.xread).toHaveBeenCalledWith('BLOCK', 100, 'COUNT', 2000, 'STREAMS', streamName, '$');
            expect(writer.xread).not.toHaveBeenCalled();
            expect(writer.published.some(([fields]) => (fields as string[]).includes('9'))).toBe(true);
        } finally {
            io.of('/').adapter.close();
            io._nsps.get('/other')?.adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });

    it('keeps the reader for other namespaces and disconnects it only after the last closes', async () => {
        const writer = redisConnection();
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        const root = io.of('/').adapter;
        const other = io.of('/other').adapter;
        try {
            root.close();
            expect(reader.disconnect).not.toHaveBeenCalled();
            other.close();
            expect(reader.disconnect).toHaveBeenCalledTimes(1);
            other.close();
            expect(reader.disconnect).toHaveBeenCalledTimes(1);
            expect(writer.disconnect).not.toHaveBeenCalled();
        } finally {
            io.of('/').adapter.close();
            io._nsps.get('/other')?.adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });

    /*
     * 2026-09-23 prod: the Redis connection went half-open for ~17 minutes.
     * socket.io awaits restoreSession BEFORE auth middleware for every client
     * reconnecting with a pid, so every reconnect hung until the client's
     * 20s connect timeout — daemons fell out of their RPC rooms and callers
     * got "RPC method not available". A stalled restore must degrade to a
     * plain (unrecovered) connection instead.
     */
    it('gives up on a stalled session restore so the reconnect proceeds without recovery', async () => {
        vi.useFakeTimers();
        const writer = redisConnection();
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        try {
            let outcome: unknown = 'pending';
            io.of('/').adapter.restoreSession('pid', '1-0').then(
                session => { outcome = session; },
                error => { outcome = error; });
            await vi.advanceTimersByTimeAsync(RESTORE_SESSION_TIMEOUT_MS - 1);
            expect(outcome).toBe('pending');
            await vi.advanceTimersByTimeAsync(1);
            expect(outcome).toEqual(new Error('restoreSession timed out'));
        } finally {
            vi.useRealTimers();
            io.of('/').adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });

    it('passes a prompt restore result through unchanged', async () => {
        const writer = redisConnection({
            exec: async () => [[null, null], [null, 0]],
            xrange: async () => [],
        });
        const reader = redisConnection();
        const io = new Server({ adapter: createIsolatedRedisAdapter(writer.client, reader.client, {}) });
        try {
            await expect(io.of('/').adapter.restoreSession('pid', '1-0')).rejects.toBe('session or offset not found');
        } finally {
            io.of('/').adapter.close();
            reader.client.disconnect();
            writer.client.disconnect();
        }
    });
});
