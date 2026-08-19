import { describe, expect, it, vi } from 'vitest';

// specs/daemon-spawn-project-link — after a spawn succeeds the daemon tells A+ about the new
// session so it appears in the project's conversation list. The session already exists and works
// by that point, so nothing this hook does may change the spawn outcome.

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

async function spawn(client: any, params: Record<string, unknown> = {}) {
    return handlersFrom(client).get('machine-1:spawn-happy-session')?.({
        directory: '/repo/app',
        ...params,
    });
}

describe('spawn-happy-session — project link hook', () => {
    it('reports the new session and its directory once the spawn succeeded', async () => {
        const linkSpawnedSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ linkSpawnedSession }));

        await expect(spawn(client)).resolves.toEqual({ type: 'success', sessionId: 'happy-1' });

        expect(linkSpawnedSession).toHaveBeenCalledWith({
            sessionId: 'happy-1',
            directory: '/repo/app',
        });
    });

    it('keeps the spawn successful when the hook throws', async () => {
        // The session is already created and usable. Turning a live session into a failed RPC
        // because a bookkeeping call broke would be a strictly worse outcome than being missing
        // from a list.
        const linkSpawnedSession = vi.fn(() => { throw new Error('aplus down'); });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ linkSpawnedSession }));

        await expect(spawn(client)).resolves.toEqual({ type: 'success', sessionId: 'happy-1' });
    });

    it('does not delay the spawn response on a slow link call', async () => {
        // The user is waiting for a session, not for a list to update.
        let release: (() => void) | undefined;
        const linkSpawnedSession = vi.fn(() => {
            void new Promise<void>((resolve) => { release = resolve; });
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({ linkSpawnedSession }));

        await expect(spawn(client)).resolves.toEqual({ type: 'success', sessionId: 'happy-1' });
        expect(release).toBeDefined();
        release?.();
    });

    it('works when no hook is wired at all — a plain Happy daemon has none', async () => {
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers());

        await expect(spawn(client)).resolves.toEqual({ type: 'success', sessionId: 'happy-1' });
    });

    it('does not link when the spawn asks for directory-creation approval instead', async () => {
        const linkSpawnedSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({
            linkSpawnedSession,
            spawnSession: () => Promise.resolve({
                type: 'requestToApproveDirectoryCreation', directory: '/repo/new',
            }),
        }));

        await spawn(client, { directory: '/repo/new' });

        expect(linkSpawnedSession).not.toHaveBeenCalled();
    });

    it('does not link when the spawn failed', async () => {
        const linkSpawnedSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers(rpcHandlers({
            linkSpawnedSession,
            spawnSession: () => Promise.resolve({ type: 'error', errorMessage: 'boom' }),
        }));

        await expect(spawn(client)).rejects.toThrow('boom');
        expect(linkSpawnedSession).not.toHaveBeenCalled();
    });
});
