import { installRpcPeerDiagnostics } from './rpcPeerDiagnostics';
import { log } from '@/utils/log';
import { createLogThrottle } from '@/app/monitoring/redisHealth';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import type { Redis } from 'ioredis';

/*
 * socket.io awaits `restoreSession` before auth middleware for every client
 * that reconnects with a pid, and a Redis command on a half-open connection
 * never settles. On 2026-09-23 that held every reconnect in prod until the
 * client's 20s connect timeout, for ~17 minutes. Past this deadline the client
 * connects without recovery (missed events are re-fetched over REST) instead
 * of not connecting at all.
 */
export const RESTORE_SESSION_TIMEOUT_MS = 3_000;

export function createIsolatedRedisAdapter(
    writer: Redis,
    reader: Redis,
    options: Parameters<typeof createAdapter>[1],
): ReturnType<typeof createAdapter> {
    // The 0.2.x adapter runs ioredis XREAD BLOCK 100 on its publishing client.
    // Redis queues XADD behind that read, on both the requesting and replying
    // replicas. These dedicated clients share configuration, not a connection.
    // Leave all writes/recovery operations (including instrumented xadd) intact.
    writer.xread = reader.xread.bind(reader);
    const create = createAdapter(writer, options);
    const active = new Set<ReturnType<typeof create>>();
    const shouldLogRestoreTimeout = createLogThrottle(60_000);
    return function (namespace) {
        const adapter = create(namespace);
        const restoreSession = adapter.restoreSession.bind(adapter);
        adapter.restoreSession = (pid, offset) => {
            let timer: NodeJS.Timeout | undefined;
            // Rejecting is how the adapter itself reports "nothing to restore";
            // socket.io catches it and connects the client fresh.
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    if (shouldLogRestoreTimeout('restore')) {
                        log({ module: 'websocket', level: 'warn' },
                            `restoreSession exceeded ${RESTORE_SESSION_TIMEOUT_MS}ms (throttled to 1/min) — connecting without recovery; Redis may be stalled`);
                    }
                    reject(new Error('restoreSession timed out'));
                }, RESTORE_SESSION_TIMEOUT_MS);
            });
            return Promise.race([restoreSession(pid, offset), deadline]).finally(() => clearTimeout(timer));
        };
        installRpcPeerDiagnostics(adapter, row => log({ module: 'rpc-peer-diagnostics' }, JSON.stringify(row)));
        active.add(adapter);
        const close = adapter.close.bind(adapter);
        adapter.close = () => {
            if (!active.delete(adapter)) return;
            // Stop the upstream poll loop before disconnecting its reader.
            close();
            if (active.size === 0) reader.disconnect();
        };
        return adapter;
    };
}
