/** The offline session stub is a no-op for every session method a runner calls before reconnection. */
import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { queueInputEvidence } from '@/api/turnInputEvidence';
import { createOfflineSessionStub, transferOfflineRegistrations } from './offlineSessionStub';

function fakeRealSession() {
    return {
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
    };
}

describe('createOfflineSessionStub', () => {
    it('takes the Codex sub-agent mark as a no-op', () => {
        const session = createOfflineSessionStub('test');
        expect(session.markLaunchedBackgroundJob()).toBeUndefined();
    });

    it('witnesses queued input the way the real session does', () => {
        const session = createOfflineSessionStub('test');
        const message = { role: 'user', content: { type: 'text', text: 'hi' }, serverMessageId: 'm-1', serverSeq: 7 } as const;
        expect(session.queueInput(message)).toEqual(queueInputEvidence(message));
        expect(session.queueInput(message)).toEqual({ ref: { kind: 'rest', serverMessageId: 'm-1', serverSeq: 7 } });
    });
});

describe('transferOfflineRegistrations', () => {
    it('attaches the handlers registered while offline to the real session', () => {
        const stub = createOfflineSessionStub('test');
        const onMessage = vi.fn();
        const onFile = vi.fn();
        const abort = vi.fn();
        const kill = vi.fn();
        stub.onUserMessage(onMessage);
        stub.onFileEvent(onFile);
        stub.rpcHandlerManager.registerHandler('abort', abort);
        stub.rpcHandlerManager.registerHandler('killSession', kill, { customerBound: true });

        const real = fakeRealSession();
        transferOfflineRegistrations(stub, real as unknown as ApiSessionClient);

        expect(real.onUserMessage).toHaveBeenCalledExactlyOnceWith(onMessage);
        expect(real.onFileEvent).toHaveBeenCalledExactlyOnceWith(onFile);
        expect(real.rpcHandlerManager.registerHandler.mock.calls).toEqual([
            ['abort', abort, undefined],
            ['killSession', kill, { customerBound: true }],
        ]);
    });

    it('keeps only the last registration for the same target, as the real session does', () => {
        const stub = createOfflineSessionStub('test');
        const firstMessage = vi.fn();
        const lastMessage = vi.fn();
        const firstAbort = vi.fn();
        const lastAbort = vi.fn();
        stub.onUserMessage(firstMessage);
        stub.onUserMessage(lastMessage);
        stub.rpcHandlerManager.registerHandler('abort', firstAbort, { customerBound: true });
        stub.rpcHandlerManager.registerHandler('abort', lastAbort);

        const real = fakeRealSession();
        transferOfflineRegistrations(stub, real as unknown as ApiSessionClient);

        expect(real.onUserMessage).toHaveBeenCalledExactlyOnceWith(lastMessage);
        expect(real.rpcHandlerManager.registerHandler.mock.calls).toEqual([['abort', lastAbort, undefined]]);
    });

    it('registers RPC handlers before the user-message handler, which may drain queued input at once', () => {
        const stub = createOfflineSessionStub('test');
        const order: string[] = [];
        stub.onUserMessage(vi.fn());
        stub.rpcHandlerManager.registerHandler('abort', vi.fn());
        const real = {
            onUserMessage: vi.fn(() => { order.push('user-message'); }),
            onFileEvent: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn((method: string) => { order.push(method); }) },
        };

        transferOfflineRegistrations(stub, real as unknown as ApiSessionClient);

        expect(order).toEqual(['abort', 'user-message']);
    });

    it('empties the record once transferred', () => {
        const stub = createOfflineSessionStub('test');
        stub.onUserMessage(vi.fn());
        stub.onFileEvent(vi.fn());
        stub.rpcHandlerManager.registerHandler('abort', vi.fn());
        transferOfflineRegistrations(stub, fakeRealSession() as unknown as ApiSessionClient);

        const second = fakeRealSession();
        transferOfflineRegistrations(stub, second as unknown as ApiSessionClient);

        expect(second.onUserMessage).not.toHaveBeenCalled();
        expect(second.onFileEvent).not.toHaveBeenCalled();
        expect(second.rpcHandlerManager.registerHandler).not.toHaveBeenCalled();
    });

    it('does nothing for a session that is not an offline stub', () => {
        const notStub = fakeRealSession();
        const real = fakeRealSession();
        transferOfflineRegistrations(notStub as unknown as ApiSessionClient, real as unknown as ApiSessionClient);

        expect(real.onUserMessage).not.toHaveBeenCalled();
        expect(real.rpcHandlerManager.registerHandler).not.toHaveBeenCalled();
    });
});
