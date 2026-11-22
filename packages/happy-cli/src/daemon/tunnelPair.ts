/**
 * Two in-memory stream ends that behave as the two ends of one connection: bytes written
 * to one are read from the other, ending or destroying one ends the other.
 *
 * The strict remote-screen channel (viewer-channel-strict-design.md §4-1) ends a relayed
 * tunnel inside the daemon instead of on a loopback port. One end is the tunnel's upstream
 * (previewWsProxy.ts); the other is handed to an HTTP server as a connection, which Node
 * accepts from any Duplex. `ws` also calls the socket timers on it, so both ends carry them
 * as no-ops: nothing here idles out on its own. (Node 22's `duplexPair` would do, but the
 * CLI still runs on Node 20.)
 *
 * Bytes reach the other end on a microtask, in order, never inside the write that sent them:
 * a synchronous hand-over runs a whole request and its answer inside one `write`, re-entering
 * whoever wrote (the tunnel's relay handler) before that call returns.
 */

import { Duplex } from 'node:stream';

export type TunnelEnd = Duplex & {
    setTimeout(): TunnelEnd;
    setNoDelay(): TunnelEnd;
    setKeepAlive(): TunnelEnd;
};

export function createTunnelPair(): { outer: TunnelEnd; inner: TunnelEnd } {
    let outer: TunnelEnd;
    let inner: TunnelEnd;
    const end = (peer: () => TunnelEnd): TunnelEnd => {
        const stream = new Duplex({
            read() {},
            write(chunk: Buffer, _encoding, callback) {
                queueMicrotask(() => peer().push(chunk));
                callback();
            },
            final(callback) {
                queueMicrotask(() => peer().push(null));
                callback();
            },
            destroy(error, callback) {
                peer().destroy();
                callback(error);
            },
        }) as TunnelEnd;
        stream.setTimeout = () => stream;
        stream.setNoDelay = () => stream;
        stream.setKeepAlive = () => stream;
        return stream;
    };
    outer = end(() => inner);
    inner = end(() => outer);
    return { outer, inner };
}
