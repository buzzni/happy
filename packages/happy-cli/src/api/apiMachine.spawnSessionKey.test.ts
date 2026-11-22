/**
 * spawn param `returnSessionKey` (aplus-dev-studio specs/agent-app-api, "세션별 암호화").
 *
 * A server-started agent-app session must be readable by the server that started it. On a dataKey
 * account each session gets its own key, which the server never receives, so the server polled
 * messages it could not open until the turn timed out. The daemon learns the key when the child
 * reports itself, before it answers the spawn, and the answer is sealed to the machine key the
 * server already holds — so it can hand the key back, but only when asked and never on a strict
 * machine, whose contract is that the server cannot read session content.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
    currentCliVersion: 'test',
    happyHomeDir: '/tmp/happy-test',
    happyLibDir: '/tmp/happy-test/lib',
    isDaemonProcess: true,
    logsDir: '/tmp/happy-test/logs',
    serverUrl: 'http://127.0.0.1:3005',
    machineControl: undefined as string | undefined,
}));

vi.mock('@/configuration', () => ({ configuration: config }));

const SESSION_KEY = Buffer.alloc(32, 9).toString('base64');

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any;
}

async function spawnHandler(spawnSession: unknown, readSessionEncryption?: unknown) {
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers({
        spawnSession,
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
        ...(readSessionEncryption ? { readSessionEncryption } : {}),
    } as any);
    return (client as any).rpcHandlerManager.handlers.get('machine-1:spawn-happy-session') as (params: any) => Promise<any>;
}

describe('spawn returnSessionKey', () => {
    afterEach(() => {
        config.machineControl = undefined;
    });

    it('returns the per-session key of a dataKey session when asked', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const readSessionEncryption = vi.fn((sessionId: string) => (sessionId === 'happy-1'
            ? { encryptionKey: SESSION_KEY, encryptionVariant: 'dataKey' }
            : null));
        const handler = await spawnHandler(spawnSession, readSessionEncryption);

        const reply = await handler({ directory: '/tmp/project', returnSessionKey: true });

        expect(reply).toMatchObject({ type: 'success', sessionId: 'happy-1', sessionKey: { variant: 'dataKey', key: SESSION_KEY } });
    });

    it('says a legacy session needs no key of its own, without sending one', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession, () => ({ encryptionKey: SESSION_KEY, encryptionVariant: 'legacy' }));

        const reply = await handler({ directory: '/tmp/project', returnSessionKey: true });

        expect(reply.sessionKey).toEqual({ variant: 'legacy' });
    });

    it('answers without a key when the session never reported one, so the caller fails instead of guessing', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession, () => null);

        const reply = await handler({ directory: '/tmp/project', returnSessionKey: true });

        expect(reply).toMatchObject({ type: 'success', sessionId: 'happy-1' });
        expect(reply.sessionKey).toBeUndefined();
    });

    it('keeps an ordinary spawn free of the key', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const readSessionEncryption = vi.fn(() => ({ encryptionKey: SESSION_KEY, encryptionVariant: 'dataKey' }));
        const handler = await spawnHandler(spawnSession, readSessionEncryption);

        const reply = await handler({ directory: '/tmp/project' });

        expect(reply.sessionKey).toBeUndefined();
        expect(readSessionEncryption).not.toHaveBeenCalled();
    });

    it.each([
        { label: 'a non-boolean request', params: { returnSessionKey: 'yes' }, strict: false, error: /must be a boolean/ },
        { label: 'a request on a strict machine', params: { returnSessionKey: true }, strict: true, error: /strict/ },
    ])('refuses $label before spawning', async ({ params, strict, error }) => {
        if (strict) config.machineControl = 'strict';
        const spawnSession = vi.fn();
        const handler = await spawnHandler(spawnSession, () => ({ encryptionKey: SESSION_KEY, encryptionVariant: 'dataKey' }));

        await expect(handler({ directory: '/tmp/project', ...params })).rejects.toThrow(error);
        expect(spawnSession).not.toHaveBeenCalled();
    });
});
