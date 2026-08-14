import { describe, expect, it } from 'vitest';
import { hasActiveUserScopedSocket } from './hasActiveUserScopedSocket';

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

describe('hasActiveUserScopedSocket', () => {
    it('shouldQueryTheUserScopedRoomNotTheGeneralUserRoom', async () => {
        const { io, seen } = fakeIo([]);
        await hasActiveUserScopedSocket(io, 'u1');
        expect(seen.room).toBe('user:u1:user-scoped');
    });

    it('shouldReturnTrueForAConnectedUserScopedSocketWithNoAppStateYet', async () => {
        const { io } = fakeIo([{ id: 's1', data: { appState: undefined } }]);
        expect(await hasActiveUserScopedSocket(io, 'u1')).toBe(true);
    });

    it('shouldReturnFalseWhenTheOnlyUserScopedSocketIsBackgrounded', async () => {
        const { io } = fakeIo([{ id: 's1', data: { appState: 'background' } }]);
        expect(await hasActiveUserScopedSocket(io, 'u1')).toBe(false);
    });

    it('shouldReturnTrueWhenAtLeastOneUserScopedSocketIsForegroundedAmongBackgroundedOnes', async () => {
        const { io } = fakeIo([
            { id: 's1', data: { appState: 'background' } },
            { id: 's2', data: { appState: 'active' } },
        ]);
        expect(await hasActiveUserScopedSocket(io, 'u1')).toBe(true);
    });
});
