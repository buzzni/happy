import { describe, expect, it, vi } from 'vitest';
import { createRpcRequestListener } from './rpcRequestListener';
import type { RpcRequest } from './types';

const request: RpcRequest = { method: 'machine:bash', params: 'encoded-params' };

describe('createRpcRequestListener', () => {
    it('sends the handler result through the ack callback', async () => {
        const callback = vi.fn();
        const listener = createRpcRequestListener({
            handleRequest: async () => 'encrypted-response',
            logger: () => { },
        });

        await listener(request, callback);

        expect(callback).toHaveBeenCalledWith('encrypted-response');
    });

    it('does not reject when the packet arrives without an ack callback', async () => {
        const listener = createRpcRequestListener({
            handleRequest: async () => 'encrypted-response',
            logger: () => { },
        });

        await expect(listener(request, undefined)).resolves.toBeUndefined();
    });

    it('still runs the handler when the ack callback is missing', async () => {
        const handleRequest = vi.fn(async () => 'encrypted-response');
        const listener = createRpcRequestListener({
            handleRequest,
            logger: () => { },
        });

        await listener(request, undefined);

        expect(handleRequest).toHaveBeenCalledWith(request);
    });

    it('logs the dropped response when the ack callback is missing', async () => {
        const logger = vi.fn();
        const listener = createRpcRequestListener({
            handleRequest: async () => 'encrypted-response',
            logger,
        });

        await listener(request, undefined);

        expect(logger).toHaveBeenCalledWith(expect.stringContaining('machine:bash'));
    });

    it('does not reject when the handler throws', async () => {
        const listener = createRpcRequestListener({
            handleRequest: async () => { throw new Error('handler exploded'); },
            logger: () => { },
        });

        await expect(listener(request, vi.fn())).resolves.toBeUndefined();
    });

    it('does not reject when the ack callback itself throws', async () => {
        const listener = createRpcRequestListener({
            handleRequest: async () => 'encrypted-response',
            logger: () => { },
        });

        const callback = vi.fn(() => { throw new Error('socket already closed'); });

        await expect(listener(request, callback)).resolves.toBeUndefined();
    });

    it('does not reject when onRequest throws', async () => {
        const listener = createRpcRequestListener({
            handleRequest: async () => 'encrypted-response',
            logger: () => { },
            onRequest: () => { throw new Error('logging exploded'); },
        });

        await expect(listener(request, vi.fn())).resolves.toBeUndefined();
    });
});
