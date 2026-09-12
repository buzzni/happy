import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isSessionValid: vi.fn(),
    emitEphemeral: vi.fn(),
    admit: vi.fn(),
}));

vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { isSessionValid: mocks.isSessionValid, queueSessionUpdate: vi.fn() },
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitEphemeral: mocks.emitEphemeral, emitUpdate: vi.fn() },
    buildNewMessageUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
}));
vi.mock('@/app/monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: () => ({}),
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/app/events/persistSessionEvent', () => ({ persistSessionEvent: vi.fn() }));
vi.mock('@/app/events/sessionStreamRateLimiter', () => ({ sessionStreamRateLimiter: { admit: mocks.admit } }));

import { sessionUpdateHandler } from './sessionUpdateHandler';

type Handler = (...args: any[]) => Promise<void> | void;

function registerHandlers() {
    const handlers = new Map<string, Handler>();
    const socket = { on: (event: string, handler: Handler) => { handlers.set(event, handler); } } as any;
    sessionUpdateHandler('user-1', socket, { connectionType: 'session-scoped', socket } as any);
    return handlers;
}

describe('session-stream relay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isSessionValid.mockResolvedValue(true);
        mocks.admit.mockReturnValue(true);
    });

    it('fans a valid frame out as a user-scoped stream ephemeral without touching the database', async () => {
        const handlers = registerHandlers();
        const now = Date.now();

        await handlers.get('session-stream')!({ sid: 'session-1', time: now, data: 'ciphertext' });

        expect(mocks.isSessionValid).toHaveBeenCalledWith('session-1', 'user-1');
        expect(mocks.emitEphemeral).toHaveBeenCalledTimes(1);
        expect(mocks.emitEphemeral).toHaveBeenCalledWith({
            userId: 'user-1',
            payload: { type: 'stream', id: 'session-1', time: now, data: 'ciphertext' },
            recipientFilter: { type: 'user-scoped-only' },
        });
    });

    it('drops frames for sessions the sender does not own', async () => {
        mocks.isSessionValid.mockResolvedValue(false);
        const handlers = registerHandlers();

        await handlers.get('session-stream')!({ sid: 'session-x', time: Date.now(), data: 'ciphertext' });

        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
    });

    it('ignores malformed or oversized frames before any lookup', async () => {
        const handlers = registerHandlers();
        const handler = handlers.get('session-stream')!;

        await handler(null);
        await handler({ sid: 'session-1', time: 'now', data: 'x' });
        await handler({ sid: 'session-1', time: Date.now(), data: 42 });
        await handler({ sid: 'session-1', time: Date.now(), data: 'x'.repeat(16 * 1024 + 1) });

        expect(mocks.isSessionValid).not.toHaveBeenCalled();
        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
        expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('drops a frame over the per-(user, session) rate budget before the ownership lookup', async () => {
        mocks.admit.mockReturnValue(false);
        const handlers = registerHandlers();

        await handlers.get('session-stream')!({ sid: 'session-1', time: Date.now(), data: 'ciphertext' });

        expect(mocks.admit).toHaveBeenCalledWith('user-1', 'session-1');
        expect(mocks.isSessionValid).not.toHaveBeenCalled();
        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
    });
});
