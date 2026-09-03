import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
    isSessionValid: vi.fn(),
}));

vi.mock('@/app/monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: () => ({}),
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: {
        isSessionValid: (...args: unknown[]) => mocks.isSessionValid(...args),
        queueSessionUpdate: vi.fn(),
    },
}));
vi.mock('@/app/events/eventRouter', () => ({
    buildNewMessageUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
    buildStreamTextEphemeral: (sessionId: string, turnId: string, blockIndex: number, content: string) => ({
        type: 'stream-text',
        sessionId,
        turnId,
        blockIndex,
        content,
    }),
    buildUpdateSessionUpdate: vi.fn(),
    eventRouter: {
        emitEphemeral: (...args: unknown[]) => mocks.emitEphemeral(...args),
        emitUpdate: vi.fn(),
    },
}));
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/storage/seq', () => ({ allocateSessionSeq: vi.fn(), allocateUserSeq: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn() }));
vi.mock('@/app/events/persistSessionEvent', () => ({ persistSessionEvent: vi.fn() }));
vi.mock('@/app/events/sessionEventTypes', () => ({ SESSION_EVENT_TYPES: {} }));

import { sessionUpdateHandler } from './sessionUpdateHandler';

type Handler = (data: unknown) => Promise<void>;

function registerStreamHandler(connectionType: 'session-scoped' | 'user-scoped' | 'machine-scoped', sessionId?: string) {
    const handlers = new Map<string, Handler>();
    const socket = {
        id: 'socket-1',
        on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    };
    const connection = connectionType === 'session-scoped'
        ? { connectionType, sessionId: sessionId!, socket, userId: 'user-1' }
        : connectionType === 'machine-scoped'
            ? { connectionType, machineId: 'machine-1', socket, userId: 'user-1' }
            : { connectionType, socket, userId: 'user-1' };

    sessionUpdateHandler('user-1', socket as never, connection as never);
    return handlers.get('session-stream-text')!;
}

const payload = {
    sid: 'session-1',
    turnId: 'turn-1',
    blockIndex: 0,
    content: 'YQ==',
};

describe('session-stream-text handler', () => {
    beforeEach(() => {
        mocks.emitEphemeral.mockReset();
        mocks.isSessionValid.mockReset().mockResolvedValue(true);
    });

    it('accepts a preview only from the socket connected to that session', async () => {
        const matching = registerStreamHandler('session-scoped', payload.sid);
        await matching(payload);

        expect(mocks.isSessionValid).toHaveBeenCalledWith(payload.sid, 'user-1');
        expect(mocks.emitEphemeral).toHaveBeenCalledOnce();
    });

    it('rejects a preview from a socket connected to another session', async () => {
        const mismatched = registerStreamHandler('session-scoped', 'session-2');
        await mismatched(payload);

        expect(mocks.isSessionValid).not.toHaveBeenCalled();
        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
    });

    it.each(['user-scoped', 'machine-scoped'] as const)('rejects a preview from a %s socket', async (connectionType) => {
        const handler = registerStreamHandler(connectionType);
        await handler(payload);

        expect(mocks.isSessionValid).not.toHaveBeenCalled();
        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
    });

    it('preserves arrival order across an initially cold validation cache', async () => {
        let cacheIsWarm = false;
        let lookupCount = 0;
        let resolveFirstLookup!: () => void;
        const firstLookup = new Promise<void>((resolve) => {
            resolveFirstLookup = resolve;
        });
        mocks.isSessionValid.mockImplementation(async () => {
            if (cacheIsWarm) return true;
            lookupCount += 1;
            if (lookupCount === 1) {
                await firstLookup;
            }
            cacheIsWarm = true;
            return true;
        });

        const handler = registerStreamHandler('session-scoped', payload.sid);
        const first = handler({ ...payload, content: 'YQ==' });
        const second = handler({ ...payload, content: 'YWI=' });
        await Promise.resolve();
        resolveFirstLookup();
        await Promise.all([first, second]);

        expect(lookupCount).toBe(1);
        expect(mocks.emitEphemeral.mock.calls.map(([event]) => event.payload.content)).toEqual(['YQ==', 'YWI=']);
    });
});
