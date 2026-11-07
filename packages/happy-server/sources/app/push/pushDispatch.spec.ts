import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    findTokens: vi.fn(),
    deleteTokens: vi.fn(),
    isUserActive: vi.fn(),
    sendPushNotifications: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    countOutcome: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        accountPushToken: {
            findMany: mocks.findTokens,
            deleteMany: mocks.deleteTokens,
        },
    },
}));
vi.mock('@/app/push/focusTracker', () => ({ isUserActive: mocks.isUserActive }));
vi.mock('@/app/push/pushSend', () => ({ sendPushNotifications: mocks.sendPushNotifications }));
vi.mock('@/utils/log', () => ({ log: mocks.log, error: mocks.error }));
vi.mock('@/app/monitoring/metrics2', () => ({ pushOutcomesCounter: { inc: mocks.countOutcome } }));

import { dispatchSessionEventPush } from './pushDispatch';

function dispatch() {
    return dispatchSessionEventPush({
        userId: 'account-1',
        sessionId: 'session-1',
        title: "It's ready!",
        body: 'Session',
    });
}

const twoTokens = [
    { id: 'token-row-1', token: 'ExponentPushToken[a]' },
    { id: 'token-row-2', token: 'ExponentPushToken[b]' },
];

describe('dispatchSessionEventPush outcome', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isUserActive.mockResolvedValue(false);
        mocks.findTokens.mockResolvedValue(twoTokens);
        mocks.deleteTokens.mockResolvedValue({ count: 1 });
    });

    it('reports suppressed when a UI client is active, without touching tokens', async () => {
        mocks.isUserActive.mockResolvedValue(true);

        const outcome = await dispatch();

        expect(outcome).toEqual({ status: 'suppressed', tokens: 0, sent: 0, failed: 0, reason: 'user-active' });
        expect(mocks.findTokens).not.toHaveBeenCalled();
        expect(mocks.sendPushNotifications).not.toHaveBeenCalled();
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('reports no_tokens when the account has no registered device', async () => {
        mocks.findTokens.mockResolvedValue([]);

        const outcome = await dispatch();

        expect(outcome).toEqual({ status: 'no_tokens', tokens: 0, sent: 0, failed: 0 });
        expect(mocks.sendPushNotifications).not.toHaveBeenCalled();
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('reports sent with counts when every ticket is ok', async () => {
        mocks.sendPushNotifications.mockResolvedValue([{ status: 'ok' }, { status: 'ok' }]);

        const outcome = await dispatch();

        expect(outcome).toEqual({ status: 'sent', tokens: 2, sent: 2, failed: 0 });
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('reports partial, counts the permanent failure and still removes the dead token', async () => {
        mocks.sendPushNotifications.mockResolvedValue([
            { status: 'ok' },
            { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        ]);

        const outcome = await dispatch();

        expect(outcome).toEqual({ status: 'partial', tokens: 2, sent: 1, failed: 1, reason: 'DeviceNotRegistered' });
        expect(mocks.deleteTokens).toHaveBeenCalledWith({ where: { id: 'token-row-2' } });
        expect(mocks.error).toHaveBeenCalledOnce();
        expect(String(mocks.error.mock.calls[0][1])).toContain('DeviceNotRegistered');
    });

    it('reports failed with each distinct cause once when no ticket got through', async () => {
        mocks.sendPushNotifications.mockResolvedValue([
            { status: 'error', message: 'HTTP 503' },
            { status: 'error', message: 'HTTP 503' },
        ]);

        const outcome = await dispatch();

        expect(outcome).toEqual({ status: 'failed', tokens: 2, sent: 0, failed: 2, reason: 'HTTP 503' });
        expect(mocks.error).toHaveBeenCalledOnce();
    });

    it('counts tokens the send never produced a ticket for as failed', async () => {
        mocks.sendPushNotifications.mockResolvedValue([{ status: 'ok' }]);

        const outcome = await dispatch();

        expect(outcome).toMatchObject({ status: 'partial', tokens: 2, sent: 1, failed: 1 });
    });

    it('reports failed with the reason when dispatch throws', async () => {
        mocks.findTokens.mockRejectedValue(new Error('db down'));

        const outcome = await dispatch();

        expect(outcome).toEqual({ status: 'failed', tokens: 0, sent: 0, failed: 0, reason: 'db down' });
        expect(mocks.error).toHaveBeenCalledOnce();
    });

    it('still sends when the presence check itself fails', async () => {
        mocks.isUserActive.mockRejectedValue(new Error('redis down'));
        mocks.sendPushNotifications.mockResolvedValue([{ status: 'ok' }, { status: 'ok' }]);

        const outcome = await dispatch();

        expect(outcome.status).toBe('sent');
    });

    it('counts every outcome by status', async () => {
        mocks.sendPushNotifications.mockResolvedValue([{ status: 'ok' }, { status: 'ok' }]);
        await dispatch();
        mocks.findTokens.mockRejectedValue(new Error('db down'));
        await dispatch();

        expect(mocks.countOutcome.mock.calls).toEqual([[{ status: 'sent' }], [{ status: 'failed' }]]);
    });
});
