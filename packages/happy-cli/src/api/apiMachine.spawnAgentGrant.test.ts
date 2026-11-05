import { describe, expect, it, vi } from 'vitest';

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any;
}

async function spawnWith(params: Record<string, unknown>) {
    const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers({
        spawnSession,
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
    } as any);
    await (client as any).rpcHandlerManager.handlers.get('machine-1:spawn-happy-session')(params);
    return spawnSession.mock.calls[0][0].environmentVariables as Record<string, string> | undefined;
}

describe('spawn-happy-session agent capability', () => {
    // 2026-11-05: the mobile app started sessions without SAYCODE_AGENT_*, so
    // `happy agent whoami` answered not_agent_env although every session's
    // prompt tells it to delegate. Each client seeding it separately missed
    // one path after another (web 09-13, mobile, web handoff).
    it('gives a request that carries no grant a root grant at its directory', async () => {
        const env = await spawnWith({ directory: '/repo/app/.aplus/worktrees/w1', environmentVariables: { PORT: '3000' } });
        expect(env).toMatchObject({
            PORT: '3000',
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app/.aplus/worktrees/w1',
            SAYCODE_AGENT_DEPTH: '0',
        });
        expect(env?.SAYCODE_AGENT_ID).toMatch(/^ac-[0-9a-f]{16}$/);
        expect(env).not.toHaveProperty('SAYCODE_AGENT_MAX_SPAWN');
        expect(env).not.toHaveProperty('SAYCODE_AGENT_SCOPE');
    });

    it('seeds the grant when the request has no environment at all', async () => {
        const env = await spawnWith({ directory: '/repo/app' });
        expect(env).toMatchObject({ SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo/app', SAYCODE_AGENT_DEPTH: '0' });
    });

    it('keeps a grant the requester supplied, such as a child seed or a capped hub', async () => {
        const requested = {
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '0',
            SAYCODE_AGENT_ID: 'ac-child',
        };
        expect(await spawnWith({ directory: '/repo/app', environmentVariables: requested })).toEqual(requested);
    });

    it('never replaces a broken grant with a fresh root one', async () => {
        // A child whose grant fails validation must not come back as depth 0
        // with a new budget; the daemon drops the broken grant whole later.
        const requested = { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_DEPTH: '2' };
        expect(await spawnWith({ directory: '/repo/app', environmentVariables: requested })).toEqual(requested);
    });

    it('adds nothing when the directory is not absolute', async () => {
        expect(await spawnWith({ directory: '~/repo', environmentVariables: { PORT: '1' } })).toEqual({ PORT: '1' });
    });
});
