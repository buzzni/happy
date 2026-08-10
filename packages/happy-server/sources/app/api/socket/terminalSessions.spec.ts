import { describe, it, expect, beforeEach } from 'vitest';
import {
    addTerminalSession,
    getTerminalSession,
    removeTerminalSession,
    findTerminalSessionsBySocketId,
    countActiveSessionsForUser,
    setTerminalSessionBackend,
    _resetTerminalSessionsForTest,
} from './terminalSessions';

const session = (over: Partial<Parameters<typeof addTerminalSession>[0]> = {}) => ({
    id: 's1',
    userId: 'u1',
    machineId: 'm1',
    clientSocketId: 'client-1',
    daemonSocketId: 'daemon-1',
    createdAt: 1,
    ...over,
});

// Local-mode contract (no Redis backend). Cross-replica behaviour lives in
// terminalSessionStore.spec.ts.
describe('terminalSessions', () => {
    beforeEach(() => {
        setTerminalSessionBackend(null);
        _resetTerminalSessionsForTest();
    });

    it('add/get round-trips a session by id', async () => {
        await addTerminalSession(session({ createdAt: 1000 }));
        const got = await getTerminalSession('s1');
        expect(got).not.toBeNull();
        expect(got!.userId).toBe('u1');
        expect(got!.machineId).toBe('m1');
        // Socket ids, not Socket objects — a session opened on one replica has
        // to be resolvable on the replica the daemon is attached to.
        expect(got!.clientSocketId).toBe('client-1');
        expect(got!.daemonSocketId).toBe('daemon-1');
    });

    it('getTerminalSession returns null for unknown / missing id', async () => {
        expect(await getTerminalSession('nope')).toBeNull();
        expect(await getTerminalSession(undefined)).toBeNull();
        expect(await getTerminalSession(null)).toBeNull();
        expect(await getTerminalSession('')).toBeNull();
    });

    it('removeTerminalSession reports whether the entry existed', async () => {
        await addTerminalSession(session());
        expect(await removeTerminalSession('s1')).toBe(true);
        expect(await removeTerminalSession('s1')).toBe(false);
        expect(await getTerminalSession('s1')).toBeNull();
    });

    it('findTerminalSessionsBySocketId matches both client and daemon side', async () => {
        await addTerminalSession(session({ id: 's1', clientSocketId: 'client', daemonSocketId: 'daemon' }));
        await addTerminalSession(session({ id: 's2', machineId: 'm2', clientSocketId: 'client', daemonSocketId: 'other-daemon', createdAt: 2 }));
        await addTerminalSession(session({ id: 's3', userId: 'u2', machineId: 'm3', clientSocketId: 'x', daemonSocketId: 'y', createdAt: 3 }));

        expect((await findTerminalSessionsBySocketId('client')).map(s => s.id).sort()).toEqual(['s1', 's2']);
        expect((await findTerminalSessionsBySocketId('daemon')).map(s => s.id)).toEqual(['s1']);
        expect(await findTerminalSessionsBySocketId('unrelated')).toEqual([]);
    });

    it('countActiveSessionsForUser counts only that user', async () => {
        await addTerminalSession(session({ id: 's1' }));
        await addTerminalSession(session({ id: 's2', machineId: 'm2', createdAt: 2 }));
        await addTerminalSession(session({ id: 's3', userId: 'u2', machineId: 'm3', createdAt: 3 }));

        expect(await countActiveSessionsForUser('u1')).toBe(2);
        expect(await countActiveSessionsForUser('u2')).toBe(1);
        expect(await countActiveSessionsForUser('u3')).toBe(0);
    });
});
