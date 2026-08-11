import { describe, expect, it, vi } from 'vitest';

function machineClient(encryptionVariant: 'legacy' | 'dataKey' = 'legacy') {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant,
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

describe('ApiMachineClient spawn/resume RPC passthrough', () => {
    it.each([
        { label: 'null', params: null },
        { label: 'string', params: 'invalid' },
        { label: 'array', params: [] },
    ])(
        'rejects $label spawn params before invoking spawnSession',
        async ({ params }) => {
            const spawnSession = vi.fn();
            const { ApiMachineClient } = await import('./apiMachine');
            const client = new ApiMachineClient('token', machineClient());
            client.setRPCHandlers(rpcHandlers({ spawnSession }));

            await expect(
                handlersFrom(client).get('machine-1:spawn-happy-session')?.(params)
            ).rejects.toThrow('Spawn parameters must be an object');
            expect(spawnSession).not.toHaveBeenCalled();
        }
    );

    it('rejects empty dataKey params after decrypt returns null without spawning a session', async () => {
        const spawnSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const { decodeBase64, decrypt } = await import('./encryption');
        const machine = machineClient('dataKey');
        const client = new ApiMachineClient('token', machine);
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        const encryptedResponse = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:spawn-happy-session',
            params: '',
        });

        expect(decrypt(machine.encryptionKey, 'dataKey', decodeBase64(encryptedResponse))).toEqual({
            error: 'Spawn parameters must be an object',
        });
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('forwards only the encrypted MCP caller grant envelope to spawnSession', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
            mcpCallerGrantEnvelope: 'ENCRYPTED-ONLY',
            mcpConfigProjectId: 'P-1',
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            mcpCallerGrantEnvelope: 'ENCRYPTED-ONLY',
            mcpConfigProjectId: 'P-1',
        }));
        expect(spawnSession).not.toHaveBeenCalledWith(expect.objectContaining({
            mcpCallerGrant: expect.anything(),
        }));
    });

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

    it('forwards axStep and bootstrapFiles to spawnSession', async () => {
        const calls: any[] = [];
        const spawnSession = (options: any) => {
            calls.push(options);
            return Promise.resolve({ type: 'success', sessionId: 'happy-1' });
        };
        const bootstrapFiles = [{
            relativePath: '.aplus/agent/project-template.md',
            content: '# Project',
        }];

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ spawnSession }));

        await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'claude',
            axStep: 'plan',
            bootstrapFiles,
        });

        expect(calls[0]).toEqual(expect.objectContaining({
            axStep: 'plan',
            bootstrapFiles,
        }));
    });

    it('forwards encrypted MCP grant fields to resumeSession', async () => {
        const resumeSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ resumeSession }));

        await handlersFrom(client).get('machine-1:resume-happy-session')?.({
            sessionId: 'happy-1',
            permissionMode: 'bypassPermissions',
            mcpCallerGrantEnvelope: 'ENCRYPTED-RESUME-GRANT',
            mcpConfigProjectId: 'P-1',
        });

        expect(resumeSession).toHaveBeenCalledWith('happy-1', expect.objectContaining({
            permissionMode: 'bypassPermissions',
            mcpCallerGrantEnvelope: 'ENCRYPTED-RESUME-GRANT',
            mcpConfigProjectId: 'P-1',
        }));
    });
});
