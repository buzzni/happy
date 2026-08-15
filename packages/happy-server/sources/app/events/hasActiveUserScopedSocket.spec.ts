import { describe, expect, it } from 'vitest';
import { hasActiveUserScopedSocketIn, userScopedRoom } from './hasActiveUserScopedSocket';
import { eventRouter } from './eventRouter';

function fakeIo(sockets: any[]) {
    const seen: { room?: string } = {};
    const io = {
        in(room: string) {
            seen.room = room;
            return {
                fetchSockets: async () => sockets,
            };
        },
    };
    return { io: io as any, seen };
}

describe('userScopedRoom', () => {
    it('shouldKeepTheRoomNameStableBecauseItIsAWireFormat', () => {
        // During a rolling deploy old and new replicas share this room
        // through the Redis adapter. Renaming it partitions live clients:
        // events fan out to one name while half the fleet joined the other.
        expect(userScopedRoom('u1')).toBe('user:u1:user-scoped');
    });
});

describe('hasActiveUserScopedSocketIn', () => {
    it('shouldQueryTheUserScopedRoomNotTheGeneralUserRoom', async () => {
        // `user:{userId}` also holds the CLI's session-scoped socket and the
        // daemon's machine-scoped one — querying it is what caused the
        // 2026-08-14 silent push suppression.
        const { io, seen } = fakeIo([]);
        await hasActiveUserScopedSocketIn(io, 'u1');
        expect(seen.room).toBe('user:u1:user-scoped');
    });

    it('shouldReturnFalseWhenNoUserScopedSocketIsConnected', async () => {
        const { io } = fakeIo([]);
        expect(await hasActiveUserScopedSocketIn(io, 'u1')).toBe(false);
    });

    it('shouldReturnTrueForAConnectedUserScopedSocketWithNoAppStateYet', async () => {
        const { io } = fakeIo([{ id: 's1', data: { appState: undefined } }]);
        expect(await hasActiveUserScopedSocketIn(io, 'u1')).toBe(true);
    });

    it('shouldReturnFalseWhenTheOnlyUserScopedSocketIsBackgrounded', async () => {
        const { io } = fakeIo([{ id: 's1', data: { appState: 'background' } }]);
        expect(await hasActiveUserScopedSocketIn(io, 'u1')).toBe(false);
    });

    it('shouldReturnTrueWhenAtLeastOneUserScopedSocketIsForegroundedAmongBackgroundedOnes', async () => {
        const { io } = fakeIo([
            { id: 's1', data: { appState: 'background' } },
            { id: 's2', data: { appState: 'active' } },
        ]);
        expect(await hasActiveUserScopedSocketIn(io, 'u1')).toBe(true);
    });
});

describe('eventRouter.hasActiveUserScopedSocket', () => {
    // The method and the free function share a name; the method must delegate
    // to the import, not to itself. Without this test a `this.`-prefixed
    // "cleanup" would turn it into infinite recursion silently.
    it('shouldDelegateToTheUserScopedRoomQueryUsingItsOwnIo', async () => {
        const { io, seen } = fakeIo([{ id: 's1', data: { appState: 'active' } }]);
        eventRouter.init(io);
        expect(await eventRouter.hasActiveUserScopedSocket('u1')).toBe(true);
        expect(seen.room).toBe('user:u1:user-scoped');
    });
});
