/** An offline-started session keeps working after reconnection: the stub's handlers move to the real session. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let capturedOnReconnected: (() => Promise<unknown>) | null = null;

vi.mock('@/utils/serverConnectionErrors', () => ({
    startOfflineReconnection: (config: { onReconnected: () => Promise<unknown> }) => {
        capturedOnReconnected = config.onReconnected;
        return { cancel: () => {}, getSession: () => null, isReconnected: () => false };
    },
}));

import { setupOfflineReconnection } from './setupOfflineReconnection';

/** Stands in for `ApiSessionClient`: keeps what was registered so the test can deliver through it. */
function makeRealSession(order: string[] = []) {
    const rpc = new Map<string, (params?: unknown) => unknown>();
    let userMessage: ((message: unknown) => void) | null = null;
    return {
        sessionId: 'real-session',
        onUserMessage: vi.fn((handler: (message: unknown) => void) => {
            order.push('user-message');
            userMessage = handler;
        }),
        onFileEvent: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: (params?: unknown) => unknown) => {
                order.push(method);
                rpc.set(method, handler);
            }),
        },
        deliver: (message: unknown) => userMessage?.(message),
        call: (method: string) => rpc.get(method)?.(),
    };
}

function setupOffline(realSession: ReturnType<typeof makeRealSession>, onSessionSwap: (session: unknown) => void = vi.fn()) {
    const api = {
        getOrCreateSession: vi.fn().mockResolvedValue({ id: 'real-session' }),
        sessionSyncClient: vi.fn().mockReturnValue(realSession),
    };
    const result = setupOfflineReconnection({
        api: api as any,
        sessionTag: 'tag-1',
        metadata: {} as any,
        state: {} as any,
        response: null,
        onSessionSwap,
    });
    return { result, api };
}

describe('setupOfflineReconnection', () => {
    beforeEach(() => {
        capturedOnReconnected = null;
    });

    it('delivers app messages, abort and kill on the real session to the handlers registered while offline', async () => {
        const realSession = makeRealSession();
        const { result } = setupOffline(realSession);
        expect(result.isOffline).toBe(true);
        const onMessage = vi.fn();
        const abort = vi.fn();
        const kill = vi.fn();
        result.session.onUserMessage(onMessage);
        result.session.rpcHandlerManager.registerHandler('abort', abort);
        result.session.rpcHandlerManager.registerHandler('killSession', kill);

        await capturedOnReconnected!();
        realSession.deliver({ role: 'user', content: { type: 'text', text: 'hi' } });
        realSession.call('abort');
        realSession.call('killSession');

        expect(onMessage).toHaveBeenCalledWith({ role: 'user', content: { type: 'text', text: 'hi' } });
        expect(abort).toHaveBeenCalledOnce();
        expect(kill).toHaveBeenCalledOnce();
    });

    it('attaches the handlers before handing the real session to onSessionSwap', async () => {
        const order: string[] = [];
        const realSession = makeRealSession(order);
        const { result } = setupOffline(realSession, () => { order.push('swap'); });
        result.session.onUserMessage(vi.fn());
        result.session.rpcHandlerManager.registerHandler('abort', vi.fn());

        await capturedOnReconnected!();

        expect(order).toEqual(['abort', 'user-message', 'swap']);
    });

    it('keeps the handlers for the next attempt when the server cannot create the session yet', async () => {
        const realSession = makeRealSession();
        const onSessionSwap = vi.fn();
        const { result, api } = setupOffline(realSession, onSessionSwap);
        const onMessage = vi.fn();
        result.session.onUserMessage(onMessage);
        api.getOrCreateSession.mockResolvedValueOnce(null);

        await expect(capturedOnReconnected!()).rejects.toThrow('Server unavailable');
        expect(onSessionSwap).not.toHaveBeenCalled();
        await capturedOnReconnected!();

        expect(realSession.onUserMessage).toHaveBeenCalledExactlyOnceWith(onMessage);
        expect(onSessionSwap).toHaveBeenCalledExactlyOnceWith(realSession);
    });

    it('uses the server session directly when online, with nothing to transfer', () => {
        const realSession = makeRealSession();
        const api = { sessionSyncClient: vi.fn().mockReturnValue(realSession) };
        const result = setupOfflineReconnection({
            api: api as any,
            sessionTag: 'tag-1',
            metadata: {} as any,
            state: {} as any,
            response: { id: 'real-session' } as any,
            onSessionSwap: vi.fn(),
        });

        expect(result).toEqual({ session: realSession, reconnectionHandle: null, isOffline: false });
        expect(capturedOnReconnected).toBeNull();
    });
});
