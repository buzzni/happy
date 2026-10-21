import { describe, expect, it } from 'vitest';
import { eventRouter } from './eventRouter';

function fakeSocket() {
    const joined: string[] = [];
    return { joined, socket: { join: (room: string) => { joined.push(room); } } as any };
}

describe('eventRouter.addConnection room membership', () => {
    // 2026-08-14 incident: the CLI's own session-scoped socket for its
    // coding session got counted as "a human is looking at a screen",
    // which suppressed the push notification for its own completed turn
    // while no human client was ever connected to see the realtime update
    // either. hasActiveUserScopedSocket relies on `user:{userId}:user-scoped`
    // containing only human-facing clients — that guarantee is enforced
    // here, at connection time, not by the query.
    it('shouldNotJoinASessionScopedConnectionToTheUserScopedRoom', () => {
        const { joined, socket } = fakeSocket();
        eventRouter.addConnection('u1', { connectionType: 'session-scoped', socket, userId: 'u1', sessionId: 's1' });
        expect(joined).not.toContain('user:u1:user-scoped');
    });

    it('shouldNotJoinAMachineScopedConnectionToTheUserScopedRoom', () => {
        const { joined, socket } = fakeSocket();
        eventRouter.addConnection('u1', { connectionType: 'machine-scoped', socket, userId: 'u1', machineId: 'm1' });
        expect(joined).not.toContain('user:u1:user-scoped');
    });

    it('shouldJoinAUserScopedConnectionToTheUserScopedRoom', () => {
        const { joined, socket } = fakeSocket();
        eventRouter.addConnection('u1', { connectionType: 'user-scoped', socket, userId: 'u1' });
        expect(joined).toContain('user:u1:user-scoped');
    });

    // A desktop opens extra user-scoped sockets only to send RPCs, relay a
    // terminal, or write a title. They never read `update`/`ephemeral`, yet
    // every session event of the account was fanned out to each of them.
    // A transport-only socket keeps every user-scoped handler (it is still a
    // user-scoped connection) but stays out of the fan-out room — and so out
    // of the "a human is looking" presence query as well.
    it('shouldNotJoinATransportOnlyUserScopedConnectionToTheUserScopedRoom', () => {
        const { joined, socket } = fakeSocket();
        eventRouter.addConnection('u1', { connectionType: 'user-scoped', socket, userId: 'u1', transportOnly: true });
        expect(joined).not.toContain('user:u1:user-scoped');
        expect(joined).toContain('user:u1');
    });
});
