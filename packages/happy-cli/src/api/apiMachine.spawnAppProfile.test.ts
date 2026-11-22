/**
 * spawn param `appProfile` (aplus-dev-studio specs/agent-app-api T5).
 *
 * `spawn-happy-session` destructures its parameters, so an unknown field is dropped without a word —
 * and a dropped profile would run a public app's session with every tool of the machine. Both halves
 * need a test: the profile reaches the daemon spawn, and one the session could not honour is refused
 * before anything is created.
 */
import { describe, expect, it, vi } from 'vitest';

const appProfile = { version: 1, mcpServers: ['shopping'], systemPrompt: '너는 쇼핑 도우미다.' };

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any;
}

async function spawnHandler(spawnSession: unknown) {
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers({
        spawnSession,
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
    } as any);
    return (client as any).rpcHandlerManager.handlers.get('machine-1:spawn-happy-session') as (params: any) => Promise<any>;
}

const runOnce = { directory: '/tmp/project', agent: 'claude', initialPrompt: '운동화 추천해줘', exitAfterFirstTurn: true };

describe('spawn app profile', () => {
    it('passes the profile of a run-once Claude session to the daemon spawn', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler({ ...runOnce, appProfile });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ appProfile }));
    });

    it('keeps an ordinary spawn free of the field', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler(runOnce);

        expect(spawnSession.mock.calls[0][0].appProfile).toBeUndefined();
    });

    it.each([
        { label: 'a malformed profile', params: { ...runOnce, appProfile: { ...appProfile, mcpServers: [] } }, error: /App profile/ },
        { label: 'a session that is not run-once', params: { directory: '/tmp/project', agent: 'claude', appProfile }, error: /run-once/ },
        { label: 'a provider other than Claude', params: { ...runOnce, agent: 'codex', appProfile }, error: /Claude/ },
    ])('refuses $label before spawning', async ({ params, error }) => {
        const spawnSession = vi.fn();
        const handler = await spawnHandler(spawnSession);

        await expect(handler(params)).rejects.toThrow(error);
        expect(spawnSession).not.toHaveBeenCalled();
    });
});
