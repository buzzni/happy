/**
 * Builds the `rpc-request` socket listener shared by the machine and session
 * clients.
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
        options.onRequest?.(data);
        callback!(await options.handleRequest(data));
    };
}
