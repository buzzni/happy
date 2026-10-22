/**
 * spawn param `outputFormat` (Saycode specs/claude-cli-benchmark-followups R2).
 *
 * `spawn-happy-session` destructures its parameters, so an unknown field is dropped without a
 * word. Both halves need a test: the format reaches the daemon spawn, and a format the session
 * could not honour is refused before anything is created.
 */
import { describe, expect, it, vi } from 'vitest';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

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

describe('spawn output format', () => {
    it('passes a Claude output format to the daemon spawn', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler({ directory: '/tmp/project', agent: 'claude', outputFormat: { type: 'json_schema', schema } });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            outputFormat: { type: 'json_schema', schema },
        }));
    });

    it('treats an omitted agent as Claude, the spawn default', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler({ directory: '/tmp/project', outputFormat: { type: 'json_schema', schema } });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ outputFormat: { type: 'json_schema', schema } }));
    });

    it('keeps an ordinary spawn free of the field', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler({ directory: '/tmp/project', agent: 'claude' });

        expect(spawnSession.mock.calls[0][0].outputFormat).toBeUndefined();
    });

    it.each([
        { label: 'a provider without structured output', params: { agent: 'codex', outputFormat: { type: 'json_schema', schema } }, error: /only supported for Claude/ },
        { label: 'an unknown format type', params: { agent: 'claude', outputFormat: { type: 'text' } }, error: /json_schema/ },
        { label: 'a schema that does not compile', params: { agent: 'claude', outputFormat: { type: 'json_schema', schema: { type: 'objectt' } } }, error: /not a valid JSON Schema/ },
    ])('refuses $label before spawning', async ({ params, error }) => {
        const spawnSession = vi.fn();
        const handler = await spawnHandler(spawnSession);

        await expect(handler({ directory: '/tmp/project', ...params })).rejects.toThrow(error);
        expect(spawnSession).not.toHaveBeenCalled();
    });
});
