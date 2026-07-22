import { describe, expect, it } from 'vitest';

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers;
}

function rpcHandlers(overrides: Record<string, unknown> = {}) {
    return {
        spawnSession: () => Promise.resolve({ type: 'success', sessionId: 'happy-1' }),
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: {
            allocate: () => undefined,
            get: () => undefined,
            release: () => undefined,
            list: () => [],
            sweep: () => undefined,
        },
        ...overrides,
    } as any;
}

describe('ApiMachineClient spawn-happy-session createdBy passthrough', () => {
    it('forwards createdByAccountId/createdByDisplayName to spawnSession', async () => {
        const calls: any[] = [];
        const spawnSession = (options: any) => {
            calls.push(options);
            return Promise.resolve({ type: 'success', sessionId: 'happy-1' });
        };

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        const result = await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
            createdByAccountId: 'acct-123',
            createdByDisplayName: 'Ada',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-1' });
        expect(calls).toEqual([expect.objectContaining({
            directory: '/tmp/project',
            agent: 'claude',
            createdByAccountId: 'acct-123',
            createdByDisplayName: 'Ada',
        })]);
    });

    it('omits createdBy fields from spawnSession when not supplied (backward compatible)', async () => {
        const calls: any[] = [];
        const spawnSession = (options: any) => {
            calls.push(options);
            return Promise.resolve({ type: 'success', sessionId: 'happy-1' });
        };

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
        });

        expect(calls[0].createdByAccountId).toBeUndefined();
        expect(calls[0].createdByDisplayName).toBeUndefined();
    });
});
