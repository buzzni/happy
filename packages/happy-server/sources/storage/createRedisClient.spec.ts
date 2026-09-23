import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisClient, isRedisConfigured, resolveRedisClientOptions } from './createRedisClient';

describe('isRedisConfigured', () => {
    it('shouldBeFalseWhenNoRedisEnvVarsSet', () => {
        expect(isRedisConfigured({})).toBe(false);
    });

    it('shouldBeTrueWhenRedisUrlSet', () => {
        expect(isRedisConfigured({ REDIS_URL: 'redis://localhost:6379' })).toBe(true);
    });

    it('shouldBeTrueWhenSentinelsAndMasterNameSet', () => {
        expect(isRedisConfigured({
            REDIS_SENTINELS: 'sentinel-0:26379',
            REDIS_SENTINEL_MASTER_NAME: 'mymaster',
        })).toBe(true);
    });

    it('shouldBeFalseWhenOnlySentinelsSetWithoutMasterName', () => {
        expect(isRedisConfigured({ REDIS_SENTINELS: 'sentinel-0:26379' })).toBe(false);
    });
});

describe('resolveRedisClientOptions', () => {
    it('shouldReturnUrlStringWhenOnlyRedisUrlSet', () => {
        const options = resolveRedisClientOptions({ REDIS_URL: 'redis://localhost:6379' });
        expect(options).toBe('redis://localhost:6379');
    });

    it('shouldParseCommaSeparatedSentinelsIntoHostPortPairs', () => {
        const options = resolveRedisClientOptions({
            REDIS_SENTINELS: 'sentinel-0:26379,sentinel-1:26379, sentinel-2:26379 ',
            REDIS_SENTINEL_MASTER_NAME: 'aplus-dev-studio-master',
        });
        expect(options).toMatchObject({
            sentinels: [
                { host: 'sentinel-0', port: 26379 },
                { host: 'sentinel-1', port: 26379 },
                { host: 'sentinel-2', port: 26379 },
            ],
            name: 'aplus-dev-studio-master',
            role: 'master',
        });
    });

    it('shouldPreferSentinelConfigOverRedisUrlWhenBothSet', () => {
        const options = resolveRedisClientOptions({
            REDIS_URL: 'redis://static-host:6379',
            REDIS_SENTINELS: 'sentinel-0:26379',
            REDIS_SENTINEL_MASTER_NAME: 'aplus-dev-studio-master',
        });
        expect(options).toMatchObject({ name: 'aplus-dev-studio-master' });
    });

    it('shouldThrowWhenNeitherRedisUrlNorSentinelsSet', () => {
        expect(() => resolveRedisClientOptions({})).toThrow();
    });

    it('shouldReconnectOnReadonlyErrorSoTheClientRerequestsTheCurrentMasterFromSentinel', () => {
        const options = resolveRedisClientOptions({
            REDIS_SENTINELS: 'sentinel-0:26379',
            REDIS_SENTINEL_MASTER_NAME: 'aplus-dev-studio-master',
        });
        if (typeof options === 'string') throw new Error('expected sentinel options object');
        const reconnectOnError = options.reconnectOnError!;
        expect(reconnectOnError(new Error('READONLY You can\'t write against a read only replica.'))).toBe(2);
        expect(reconnectOnError(new Error('ECONNRESET'))).toBe(false);
    });
});

/**
 * A Redis stand-in that answers PING/GET and the handshake, and can stop
 * answering on its open connections while keeping the TCP sockets open —
 * what a half-open connection looks like from the client (2026-09-23 prod:
 * ~17 minutes until the kernel gave up and ECONNRESET arrived).
 */
async function startFakeRedis() {
    const connections: net.Socket[] = [];
    const stalled = new Set<net.Socket>();
    const server = net.createServer(socket => {
        connections.push(socket);
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            for (;;) {
                const command = takeCommand();
                if (!command) return;
                if (stalled.has(socket)) continue;
                const name = command[0].toUpperCase();
                if (name === 'INFO') socket.write('$9\r\nloading:0\r\n');
                else if (name === 'PING') socket.write('+PONG\r\n');
                else socket.write('$-1\r\n');
            }
        });
        socket.on('error', () => {});
        function takeCommand(): string[] | null {
            const header = /^\*(\d+)\r\n/.exec(buffer);
            if (!header) return null;
            let at = header[0].length;
            const parts: string[] = [];
            for (let i = 0; i < Number(header[1]); i++) {
                const length = /^\$(\d+)\r\n/.exec(buffer.slice(at));
                if (!length) return null;
                const start = at + length[0].length;
                const end = start + Number(length[1]);
                if (buffer.length < end + 2) return null;
                parts.push(buffer.slice(start, end));
                at = end + 2;
            }
            buffer = buffer.slice(at);
            return parts;
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    return {
        url: `redis://127.0.0.1:${port}`,
        connectionCount: () => connections.length,
        stallOpenConnections: () => { for (const socket of connections) stalled.add(socket); },
        close: () => {
            for (const socket of connections) socket.destroy();
            return new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return condition();
}

describe('createRedisClient on a stalled connection', () => {
    const timing = { commandTimeoutMs: 100, stallCheckIntervalMs: 100 };
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        while (cleanups.length) await cleanups.pop()!();
    });

    async function connect(): Promise<{ client: Redis; fake: Awaited<ReturnType<typeof startFakeRedis>> }> {
        const fake = await startFakeRedis();
        cleanups.push(fake.close);
        const client = createRedisClient({ REDIS_URL: fake.url }, timing);
        cleanups.push(() => { client.disconnect(); });
        expect(await waitFor(() => client.status === 'ready', 2_000)).toBe(true);
        return { client, fake };
    }

    it('shouldFailACommandInsteadOfWaitingForeverWhenRedisStopsAnswering', async () => {
        const { client, fake } = await connect();
        fake.stallOpenConnections();
        await expect(client.get('key')).rejects.toThrow('Command timed out');
    });

    it('shouldReplaceAConnectionThatStoppedAnsweringWithoutWaitingForTheKernel', async () => {
        const { client, fake } = await connect();
        fake.stallOpenConnections();
        expect(await waitFor(() => fake.connectionCount() === 2 && client.status === 'ready', 3_000)).toBe(true);
        await expect(client.ping()).resolves.toBe('PONG');
    });

    it('shouldKeepAHealthyConnection', async () => {
        const { client, fake } = await connect();
        await new Promise(resolve => setTimeout(resolve, timing.stallCheckIntervalMs * 5));
        expect(fake.connectionCount()).toBe(1);
        await expect(client.ping()).resolves.toBe('PONG');
    });
});
