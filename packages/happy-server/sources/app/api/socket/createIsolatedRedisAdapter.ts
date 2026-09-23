import { installRpcPeerDiagnostics } from './rpcPeerDiagnostics';
import { log } from '@/utils/log';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import type { Redis } from 'ioredis';

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
    return function (namespace) {
        const adapter = create(namespace);
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
