import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    run: vi.fn(), session: vi.fn(),
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
        automationRun: { findFirst: mocks.run }, session: { findFirst: mocks.session },
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

/** Mimics a PrismaPromise: the query only runs once something subscribes. */
function lazyQuery() {
    const query = { executed: false, then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
        query.executed = true;
        return Promise.resolve({ count: 1 }).then(resolve, reject);
    }, catch: (reject: (reason: unknown) => void) => query.then(() => undefined, reject) };
    return query;
}

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
        mocks.deleteTokens.mockImplementation(lazyQuery);
    });

    afterEach(() => {
        vi.useRealTimers();
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
        expect(mocks.deleteTokens.mock.results[0].value.executed).toBe(true);
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

        expect(outcome).toMatchObject({ status: 'partial', tokens: 2, sent: 1, failed: 1, reason: 'missing ticket' });
        expect(String(mocks.error.mock.calls[0][1])).toContain('missing ticket');
    });

    it('reports failed with the error class only when dispatch throws, keeping the message in the log', async () => {
        class PrismaClientInitializationError extends Error { name = 'PrismaClientInitializationError'; }
        mocks.findTokens.mockRejectedValue(new PrismaClientInitializationError("Can't reach database server at db.internal:5432"));

        const outcome = await dispatch();

        expect(outcome).toEqual({ status: 'failed', tokens: 0, sent: 0, failed: 0, reason: 'exception:PrismaClientInitializationError' });
        expect(mocks.error).toHaveBeenCalledOnce();
        expect(String(mocks.error.mock.calls[0][1])).toContain('db.internal:5432');
    });

    it('gives the Expo send only what is left of the dispatch budget', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        mocks.findTokens.mockImplementation(async () => {
            vi.setSystemTime(1_000_000 + 9_500);
            return twoTokens;
        });
        mocks.sendPushNotifications.mockResolvedValue([{ status: 'ok' }, { status: 'ok' }]);

        await dispatch();

        expect(mocks.sendPushNotifications.mock.calls[0][1]).toEqual({ timeoutMs: 500 });
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

describe('isolated execution attention target', () => {
beforeEach(() => {
    vi.resetAllMocks();
    mocks.isUserActive.mockResolvedValue(false);
    mocks.findTokens.mockResolvedValue([{ id: 't1', token: 'expo-token' }]);
    mocks.sendPushNotifications.mockResolvedValue([{ status: 'ok' }]);
    mocks.run.mockResolvedValue({ id: 'r1', displaySessionId: 'manual' });
    mocks.session.mockResolvedValue({ id: 'manual' });
});

it('routes an internal execution attention event to its owned display chat with its run identity', async () => {
    await dispatchSessionEventPush({ userId: 'owner', sessionId: 'automation-run:r1',
        title: 'Permission needed', body: 'Review this run', data: { sessionId: 'spoof', runId: 'spoof', event: 'permission' } });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ where: {
        sessionId: 'automation-run:r1', machineAccountId: 'owner', displaySessionId: { not: null },
    } }));
    expect(mocks.session).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'manual', accountId: 'owner' } }));
    expect(mocks.sendPushNotifications).toHaveBeenCalledWith([expect.objectContaining({
        title: 'Permission needed', body: 'Review this run', data: {
            sessionId: 'manual', runId: 'r1', event: 'permission',
        },
    })], {timeoutMs:expect.any(Number)});
});

it.each(['unregistered', 'inaccessible', 'internal-display'])(
    'does not send a separate-chat notification for an %s execution target', async reason => {
        if (reason === 'unregistered') mocks.run.mockResolvedValue(null);
        if (reason === 'inaccessible') mocks.session.mockResolvedValue(null);
        if (reason === 'internal-display') mocks.run.mockResolvedValue({ id: 'r1', displaySessionId: 'automation-run:other' });
        expect(await dispatchSessionEventPush({ userId: 'owner', sessionId: 'automation-run:r1', title: 'Done', body: 'Result' })).toMatchObject({status:'suppressed',reason:'automation-target-unavailable'});
        expect(mocks.findTokens).not.toHaveBeenCalled();
        expect(mocks.sendPushNotifications).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }), expect.any(String));
    });

it('preserves ordinary session notifications without an automation lookup', async () => {
    await dispatchSessionEventPush({ userId: 'owner', sessionId: 'manual', title: 'Done', body: 'Result' });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.sendPushNotifications).toHaveBeenCalledWith([expect.objectContaining({ data: { sessionId: 'manual' } })], {timeoutMs:expect.any(Number)});
});

it('still suppresses a mapped run notification while the user is active', async () => {
    mocks.isUserActive.mockResolvedValue(true);
    await dispatchSessionEventPush({ userId: 'owner', sessionId: 'automation-run:r1', title: 'Done', body: 'Result' });
    expect(mocks.sendPushNotifications).not.toHaveBeenCalled();
});

});
