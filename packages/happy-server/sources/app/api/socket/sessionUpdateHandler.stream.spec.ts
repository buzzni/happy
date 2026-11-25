import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isSessionValid: vi.fn(),
    emitEphemeral: vi.fn(),
    admit: vi.fn(),
    watchSessionStream: vi.fn(),
}));

vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { isSessionValid: mocks.isSessionValid, queueSessionUpdate: vi.fn() },
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitEphemeral: mocks.emitEphemeral, emitUpdate: vi.fn(), watchSessionStream: mocks.watchSessionStream },
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

function registerHandlers(connection: Record<string, unknown> = { connectionType: 'session-scoped' }) {
    const handlers = new Map<string, Handler>();
    const socket = { on: (event: string, handler: Handler) => { handlers.set(event, handler); }, data: {} } as any;
    sessionUpdateHandler('user-1', socket, { ...connection, socket } as any);
    return { handlers, socket };
}

describe('session-stream relay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isSessionValid.mockResolvedValue(true);
        mocks.admit.mockReturnValue(true);
    });

    it('fans a valid frame out to human clients and the session stream watchers without touching the database', async () => {
        const { handlers } = registerHandlers();
        const now = Date.now();

        await handlers.get('session-stream')!({ sid: 'session-1', time: now, data: 'ciphertext' });

        expect(mocks.isSessionValid).toHaveBeenCalledWith('session-1', 'user-1', false);
        expect(mocks.emitEphemeral).toHaveBeenCalledTimes(1);
        expect(mocks.emitEphemeral).toHaveBeenCalledWith({
            userId: 'user-1',
            payload: { type: 'stream', id: 'session-1', time: now, data: 'ciphertext' },
            recipientFilter: { type: 'session-stream', sessionId: 'session-1' },
        });
    });

    it('drops frames for sessions the sender does not own', async () => {
        mocks.isSessionValid.mockResolvedValue(false);
        const { handlers } = registerHandlers();

        await handlers.get('session-stream')!({ sid: 'session-x', time: Date.now(), data: 'ciphertext' });

        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
    });

    it('ignores malformed or oversized frames before any lookup', async () => {
        const { handlers } = registerHandlers();
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
        const { handlers } = registerHandlers();

        await handlers.get('session-stream')!({ sid: 'session-1', time: Date.now(), data: 'ciphertext' });

        expect(mocks.admit).toHaveBeenCalledWith('user-1', 'session-1');
        expect(mocks.isSessionValid).not.toHaveBeenCalled();
        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
    });
});

// aplus-dev-studio specs/agent-app-api — a server running an agent-app turn watches that one session's stream.
describe('session-stream-watch', () => {
    const transportOnly = { connectionType: 'user-scoped', transportOnly: true };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isSessionValid.mockResolvedValue(true);
    });

    async function watch(connection: Record<string, unknown>, data: unknown) {
        const { handlers, socket } = registerHandlers(connection);
        const callback = vi.fn();
        await handlers.get('session-stream-watch')!(data, callback);
        return { callback, socket };
    }

    it('joins a transport-only socket to the stream of a session of its account', async () => {
        const { callback, socket } = await watch(transportOnly, { sid: 'session-1' });

        expect(mocks.isSessionValid).toHaveBeenCalledWith('session-1', 'user-1', false);
        expect(mocks.watchSessionStream).toHaveBeenCalledWith('user-1', socket, 'session-1');
        expect(callback).toHaveBeenCalledWith({ ok: true });
    });

    it('refuses a session the account does not own', async () => {
        mocks.isSessionValid.mockResolvedValue(false);

        const { callback } = await watch(transportOnly, { sid: 'session-x' });

        expect(mocks.watchSessionStream).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'session-not-found' });
    });

    it.each([
        ['a human client, which already gets every stream', { connectionType: 'user-scoped' }],
        ['a session-scoped socket', { connectionType: 'session-scoped' }],
        ['a machine-scoped socket', { connectionType: 'machine-scoped' }],
    ])('refuses %s', async (_label, connection) => {
        const { callback } = await watch(connection, { sid: 'session-1' });

        expect(mocks.isSessionValid).not.toHaveBeenCalled();
        expect(mocks.watchSessionStream).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'transport-only-socket-required' });
    });

    it.each([null, {}, { sid: 42 }, { sid: '' }, { sid: 'a:b' }])('refuses a malformed request %j before any lookup', async (data) => {
        const { callback } = await watch(transportOnly, data);

        expect(mocks.isSessionValid).not.toHaveBeenCalled();
        expect(mocks.watchSessionStream).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'invalid-session-id' });
    });
});
