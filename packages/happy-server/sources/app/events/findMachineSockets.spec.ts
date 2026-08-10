import { describe, expect, it, vi } from 'vitest';
import { findMachineSocketsIn, machineRoom, newestMachineSocket } from './findMachineSockets';

/**
 * Builds a fake `io` whose `in(room)` records the room and resolves
 * fetchSockets() with the given sockets (or rejects, to model an
 * unresponsive peer replica).
 */
function fakeIo(result: { sockets?: any[]; rejectWith?: Error }) {
    const seen: { room?: string; timeoutMs?: number } = {};
    const io = {
        in(room: string) {
            seen.room = room;
            return {
                timeout(ms: number) {
                    seen.timeoutMs = ms;
                    return {
                        fetchSockets: async () => {
                            if (result.rejectWith) throw result.rejectWith;
                            return result.sockets ?? [];
                        },
                    };
                },
            };
        },
    };
    return { io: io as any, seen };
}

const machineSocket = (id: string, machineId: string) => ({
    id,
    data: { clientType: 'machine-scoped', machineId },
});

describe('machineRoom', () => {
    it('shouldMatchTheRoomEventRouterJoinsMachineSocketsTo', () => {
        // eventRouter.addConnection joins `user:{userId}:machine:{machineId}`.
        // If these ever diverge the lookup silently returns nothing.
        expect(machineRoom('u1', 'm1')).toBe('user:u1:machine:m1');
    });
});

describe('findMachineSocketsIn', () => {
    it('shouldQueryTheMachineRoomSoTheLookupCrossesReplicas', async () => {
        const { io, seen } = fakeIo({ sockets: [machineSocket('s1', 'm1')] });
        await findMachineSocketsIn(io, 'u1', 'm1');
        expect(seen.room).toBe('user:u1:machine:m1');
    });

    it('shouldReturnSocketsFromTheRoomWithoutDegradation', async () => {
        const { io } = fakeIo({ sockets: [machineSocket('s1', 'm1'), machineSocket('s2', 'm1')] });
        const result = await findMachineSocketsIn(io, 'u1', 'm1');
        expect(result.sockets.map((s) => s.id)).toEqual(['s1', 's2']);
        expect(result.degraded).toBe(false);
    });

    it('shouldIgnoreNonMachineScopedSocketsThatShareTheRoom', async () => {
        const { io } = fakeIo({
            sockets: [
                { id: 'browser', data: { clientType: 'user-scoped' } },
                machineSocket('daemon', 'm1'),
            ],
        });
        const result = await findMachineSocketsIn(io, 'u1', 'm1');
        expect(result.sockets.map((s) => s.id)).toEqual(['daemon']);
    });

    it('shouldIgnoreMachineSocketsBelongingToAnotherMachine', async () => {
        const { io } = fakeIo({ sockets: [machineSocket('other', 'm2'), machineSocket('mine', 'm1')] });
        const result = await findMachineSocketsIn(io, 'u1', 'm1');
        expect(result.sockets.map((s) => s.id)).toEqual(['mine']);
    });

    it('shouldReportEmptyRoomAsNotDegradedSoCallersCanSayMachineOffline', async () => {
        const { io } = fakeIo({ sockets: [] });
        const result = await findMachineSocketsIn(io, 'u1', 'm1');
        expect(result.sockets).toEqual([]);
        expect(result.degraded).toBe(false);
    });

    it('shouldFlagDegradedWhenTheClusterLookupFailsInsteadOfClaimingMachineOffline', async () => {
        // A peer replica that never answers must not be reported as "the
        // machine is gone" — that misattribution is what made the 2026-08-07
        // outage look like mass daemon disconnects.
        const { io } = fakeIo({ rejectWith: new Error('timeout reached: missing 1 responses') });
        const result = await findMachineSocketsIn(io, 'u1', 'm1');
        expect(result.sockets).toEqual([]);
        expect(result.degraded).toBe(true);
    });

    it('shouldBoundTheClusterLookupWithATimeout', async () => {
        const { io, seen } = fakeIo({ sockets: [] });
        await findMachineSocketsIn(io, 'u1', 'm1', 1234);
        expect(seen.timeoutMs).toBe(1234);
    });
});

describe('newestMachineSocket', () => {
    const at = (id: string, connectedAt?: number) => ({ id, data: { connectedAt } });

    it('shouldPickTheMostRecentlyConnectedSocket', () => {
        // A daemon that reconnects after a network flap leaves the dead socket
        // registered until engine.io gives up (pingInterval + pingTimeout).
        // Sending terminal-open into the stale one surfaces as "Daemon did not
        // acknowledge in time".
        const chosen = newestMachineSocket([at('stale', 1_000), at('live', 5_000)]);
        expect(chosen?.id).toBe('live');
    });

    it('shouldNotDependOnArrayOrderBecauseFetchSocketsIsUnorderedAcrossReplicas', () => {
        const chosen = newestMachineSocket([at('live', 5_000), at('stale', 1_000)]);
        expect(chosen?.id).toBe('live');
    });

    it('shouldFallBackToTheLastEntryWhenNoSocketCarriesATimestamp', () => {
        // Sockets connected before this field shipped have no connectedAt.
        // Preserve the previous heuristic (insertion order, last = newest)
        // instead of picking arbitrarily.
        const chosen = newestMachineSocket([at('older'), at('newer')]);
        expect(chosen?.id).toBe('newer');
    });

    it('shouldPreferATimestampedSocketOverAnUntimestampedOne', () => {
        const chosen = newestMachineSocket([at('legacy'), at('fresh', 42)]);
        expect(chosen?.id).toBe('fresh');
    });

    it('shouldReturnNullWhenThereAreNoCandidates', () => {
        expect(newestMachineSocket([])).toBeNull();
    });
});
