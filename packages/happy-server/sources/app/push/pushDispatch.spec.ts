import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    run: vi.fn(), session: vi.fn(), tokens: vi.fn(), active: vi.fn(), send: vi.fn(), log: vi.fn(),
}));
vi.mock('@/storage/db', () => ({ db: {
    automationRun: { findFirst: mocks.run }, session: { findFirst: mocks.session },
    accountPushToken: { findMany: mocks.tokens, deleteMany: vi.fn() },
} }));
vi.mock('@/app/push/focusTracker', () => ({ isUserActive: mocks.active }));
vi.mock('@/app/push/pushSend', () => ({ sendPushNotifications: mocks.send }));
vi.mock('@/utils/log', () => ({ log: mocks.log }));
import { dispatchSessionEventPush } from './pushDispatch';

beforeEach(() => {
    vi.resetAllMocks();
    mocks.active.mockResolvedValue(false);
    mocks.tokens.mockResolvedValue([{ id: 't1', token: 'expo-token' }]);
    mocks.send.mockResolvedValue([{ status: 'ok' }]);
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
    expect(mocks.send).toHaveBeenCalledWith([expect.objectContaining({
        title: 'Permission needed', body: 'Review this run', data: {
            sessionId: 'manual', runId: 'r1', event: 'permission',
        },
    })]);
});

it.each(['unregistered', 'inaccessible', 'internal-display'])(
    'does not send a separate-chat notification for an %s execution target', async reason => {
        if (reason === 'unregistered') mocks.run.mockResolvedValue(null);
        if (reason === 'inaccessible') mocks.session.mockResolvedValue(null);
        if (reason === 'internal-display') mocks.run.mockResolvedValue({ id: 'r1', displaySessionId: 'automation-run:other' });
        await dispatchSessionEventPush({ userId: 'owner', sessionId: 'automation-run:r1', title: 'Done', body: 'Result' });
        expect(mocks.tokens).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }), expect.any(String));
    });

it('preserves ordinary session notifications without an automation lookup', async () => {
    await dispatchSessionEventPush({ userId: 'owner', sessionId: 'manual', title: 'Done', body: 'Result' });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith([expect.objectContaining({ data: { sessionId: 'manual' } })]);
});

it('still suppresses a mapped run notification while the user is active', async () => {
    mocks.active.mockResolvedValue(true);
    await dispatchSessionEventPush({ userId: 'owner', sessionId: 'automation-run:r1', title: 'Done', body: 'Result' });
    expect(mocks.send).not.toHaveBeenCalled();
});
