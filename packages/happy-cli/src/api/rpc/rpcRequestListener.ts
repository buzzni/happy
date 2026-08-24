/**
 * Builds the `rpc-request` socket listener shared by the machine and session
 * clients.
 *
 * WHY this is guarded rather than a bare `callback(await handleRequest(data))`:
 * socket.io does not guarantee that every delivered `rpc-request` packet
 * carries an ack callback. On 2026-08-23 a 37s server outage was followed by a
 * reconnect burst in which packets arrived with `callback === undefined`. The
 * daemon's unguarded call threw `TypeError: callback is not a function` inside
 * an async listener, which socket.io never awaits, so it surfaced as an
 * unhandled rejection — and `daemon/run.ts` treats any unhandled rejection as
 * fatal. One un-ackable request killed the whole daemon (2293 times in one
 * second), taking every tracked session's daemon with it.
 *
 * Nothing in this listener may escape as a rejection.
 */

import type { RpcRequest, RpcResponseCallback } from './types';

export interface RpcRequestListenerOptions {
    handleRequest: (data: RpcRequest) => Promise<any>;
    logger: (message: string) => void;
    /** Optional per-request logging hook; must never affect delivery. */
    onRequest?: (data: RpcRequest) => void;
}

export function createRpcRequestListener(
    options: RpcRequestListenerOptions
): (data: RpcRequest, callback?: RpcResponseCallback) => Promise<void> {
    return async (data, callback) => {
        try {
            options.onRequest?.(data);

            // The handler runs even when the ack is missing: RPC methods such as
            // bash/writeFile/spawn-happy-session are side-effecting, and a lost
            // ack is not evidence the caller withdrew the request. Only the
            // response delivery is skipped — it was already undeliverable.
            const response = await options.handleRequest(data);

            if (typeof callback !== 'function') {
                options.logger(
                    `[RPC] Dropping response — no ack callback for ${data?.method}`
                );
                return;
            }

            callback(response);
        } catch (error) {
            options.logger(
                `[RPC] rpc-request listener failed for ${data?.method}: ${error}`
            );
        }
    };
}
