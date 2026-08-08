import { describe, it, expect, beforeEach } from 'vitest';
import {
    addTerminalSession,
    getTerminalSession,
    removeTerminalSession,
    findTerminalSessionsBySocketId,
    countActiveSessionsForUser,
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

describe('terminalSessions', () => {
    beforeEach(() => {
        _resetTerminalSessionsForTest();
    });

    it('add/get round-trips a session by id', () => {
        addTerminalSession(session({ createdAt: 1000 }));
        const got = getTerminalSession('s1');
        expect(got).not.toBeNull();
        expect(got!.userId).toBe('u1');
        expect(got!.machineId).toBe('m1');
        // Socket ids, not Socket objects — a session opened on one replica has
        // to be resolvable on the replica the daemon is attached to.
        expect(got!.clientSocketId).toBe('client-1');
        expect(got!.daemonSocketId).toBe('daemon-1');
    });

    it('getTerminalSession returns null for unknown / missing id', () => {
        expect(getTerminalSession('nope')).toBeNull();
        expect(getTerminalSession(undefined)).toBeNull();
        expect(getTerminalSession(null)).toBeNull();
        expect(getTerminalSession('')).toBeNull();
    });

    it('removeTerminalSession reports whether the entry existed', () => {
        addTerminalSession(session());
        expect(removeTerminalSession('s1')).toBe(true);
        expect(removeTerminalSession('s1')).toBe(false);
        expect(getTerminalSession('s1')).toBeNull();
    });

    it('findTerminalSessionsBySocketId matches both client and daemon side', () => {
        addTerminalSession(session({ id: 's1', clientSocketId: 'client', daemonSocketId: 'daemon' }));
        addTerminalSession(session({ id: 's2', machineId: 'm2', clientSocketId: 'client', daemonSocketId: 'other-daemon', createdAt: 2 }));
        addTerminalSession(session({ id: 's3', userId: 'u2', machineId: 'm3', clientSocketId: 'x', daemonSocketId: 'y', createdAt: 3 }));

        expect(findTerminalSessionsBySocketId('client').map(s => s.id).sort()).toEqual(['s1', 's2']);
        expect(findTerminalSessionsBySocketId('daemon').map(s => s.id)).toEqual(['s1']);
        expect(findTerminalSessionsBySocketId('unrelated')).toEqual([]);
    });

    it('countActiveSessionsForUser counts only that user', () => {
        addTerminalSession(session({ id: 's1' }));
        addTerminalSession(session({ id: 's2', machineId: 'm2', createdAt: 2 }));
        addTerminalSession(session({ id: 's3', userId: 'u2', machineId: 'm3', createdAt: 3 }));

        expect(countActiveSessionsForUser('u1')).toBe(2);
        expect(countActiveSessionsForUser('u2')).toBe(1);
        expect(countActiveSessionsForUser('u3')).toBe(0);
    });
});
