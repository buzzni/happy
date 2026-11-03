import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    assertReservationWrite: vi.fn(),
    socketEmit: vi.fn(),
    sessionFindUnique: vi.fn(),
    messageFindFirst: vi.fn(),
    messageCreate: vi.fn(),
    allocateUserSeq: vi.fn(),
    allocateSessionSeq: vi.fn(),
    emitUpdate: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/app/automation/reservationConversationLease', async importOriginal => ({ ...await importOriginal<typeof import('@/app/automation/reservationConversationLease')>(), assertReservationWrite: mocks.assertReservationWrite }));

vi.mock('@/utils/log', () => ({ log: mocks.log }));

vi.mock('@/storage/db', () => ({
    db: {
        $transaction: async (fn: Function) => fn({ sessionMessage: { findFirst: mocks.messageFindFirst, create: mocks.messageCreate } }),
        session: { findUnique: mocks.sessionFindUnique },
        sessionMessage: { findFirst: mocks.messageFindFirst, create: mocks.messageCreate },
    },
}));
vi.mock('@/storage/seq', () => ({
    allocateUserSeq: mocks.allocateUserSeq,
    allocateSessionSeqBatch: mocks.allocateSessionSeq,
}));
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { isSessionValid: vi.fn(), queueSessionUpdate: vi.fn() },
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: mocks.emitUpdate, emitEphemeral: vi.fn() },
    buildNewMessageUpdate: vi.fn((message: unknown, sid: string, updSeq: number) => ({ seq: updSeq, sid, message })),
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
}));
vi.mock('@/app/monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: () => ({}),
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/app/events/persistSessionEvent', () => ({ persistSessionEvent: vi.fn() }));
vi.mock('@/app/events/sessionStreamRateLimiter', () => ({ sessionStreamRateLimiter: { admit: vi.fn(() => true) } }));

import { ReservationWriteDenied } from '@/app/automation/reservationConversationLease';
import { sessionUpdateHandler } from './sessionUpdateHandler';

type Handler = (...args: any[]) => Promise<void> | void;

function messageHandler() {
    const handlers = new Map<string, Handler>();
    const socket = { emit: mocks.socketEmit, handshake: { auth: {} }, on: (event: string, handler: Handler) => { handlers.set(event, handler); } } as any;
    sessionUpdateHandler('user-1', socket, { connectionType: 'session-scoped', socket } as any);
    return handlers.get('message')!;
}

describe('socket message persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.sessionFindUnique.mockResolvedValue({ id: 'session-1', accountId: 'user-1' });
        mocks.messageFindFirst.mockResolvedValue(null);
        mocks.allocateUserSeq.mockResolvedValue(5);
        mocks.allocateSessionSeq.mockResolvedValue([9]);
        mocks.assertReservationWrite.mockResolvedValue(undefined);
        mocks.messageCreate.mockImplementation(async (args: any) => ({ id: 'msg-1', ...args.data }));
    });

    afterEach(() => {
        // The handler catches errors. A thrown lookup must not make the
        // no-write assertions below pass as if a duplicate was found.
        expect(mocks.log.mock.calls.filter(([context]) => context.level === 'error')).toEqual([]);
    });

    it('persists a new message with the allocated seqs and announces it', async () => {
        await messageHandler()({ sid: 'session-1', message: 'ciphertext', localId: 'local-1' });

        expect(mocks.messageCreate).toHaveBeenCalledWith({
            data: {
                sessionId: 'session-1',
                seq: 9,
                content: { t: 'encrypted', c: 'ciphertext' },
                localId: 'local-1',
            },
        });
        expect(mocks.emitUpdate).toHaveBeenCalledTimes(1);
        expect(mocks.emitUpdate.mock.calls[0][0].payload.seq).toBe(5);
    });

    it('burns no seq when the localId was already persisted', async () => {
        mocks.messageFindFirst.mockResolvedValue({ id: 'msg-existing', seq: 3 });

        await messageHandler()({ sid: 'session-1', message: 'ciphertext', localId: 'local-1' });

        expect(mocks.messageFindFirst).toHaveBeenCalledWith({
            where: { sessionId: 'session-1', localId: 'local-1' },
        });
        // A retry of an already stored message must not take the contended
        // Account.seq / Session.seq row locks, and must not re-announce.
        expect(mocks.allocateUserSeq).not.toHaveBeenCalled();
        expect(mocks.allocateSessionSeq).not.toHaveBeenCalled();
        expect(mocks.messageCreate).not.toHaveBeenCalled();
        expect(mocks.emitUpdate).not.toHaveBeenCalled();
    });

    it('burns no seq when the sender does not own the session', async () => {
        mocks.sessionFindUnique.mockResolvedValue(null);

        await messageHandler()({ sid: 'session-1', message: 'ciphertext', localId: 'local-1' });

        expect(mocks.allocateUserSeq).not.toHaveBeenCalled();
        expect(mocks.allocateSessionSeq).not.toHaveBeenCalled();
        expect(mocks.emitUpdate).not.toHaveBeenCalled();
    });

    it('still allocates and persists when the client sends no localId', async () => {
        await messageHandler()({ sid: 'session-1', message: 'ciphertext' });

        expect(mocks.messageFindFirst).not.toHaveBeenCalled();
        expect(mocks.messageCreate).toHaveBeenCalledWith({
            data: {
                sessionId: 'session-1',
                seq: 9,
                content: { t: 'encrypted', c: 'ciphertext' },
                localId: null,
            },
        });
        expect(mocks.emitUpdate).toHaveBeenCalledTimes(1);
    });
});

it('keeps a busy message unpersisted and tells the sender to retain it', async () => {
    vi.clearAllMocks();
    mocks.sessionFindUnique.mockResolvedValue({ id: 'session-1', accountId: 'user-1' });
    mocks.messageFindFirst.mockResolvedValue(null);
    mocks.assertReservationWrite.mockRejectedValueOnce(new ReservationWriteDenied('reservation-busy'));
    const ack = vi.fn();
    await messageHandler()({ sid: 'session-1', message: 'ciphertext', localId: 'local-busy' }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'reservation-busy' });
    expect(mocks.socketEmit).toHaveBeenCalledWith('message-error', { sid: 'session-1', localId: 'local-busy', error: 'reservation-busy' });
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(mocks.allocateUserSeq).not.toHaveBeenCalled();
    expect(mocks.allocateSessionSeq).not.toHaveBeenCalled();
    expect(mocks.emitUpdate).not.toHaveBeenCalled();
});
