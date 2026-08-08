import type { RemoteSocket, Server } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';

/**
 * Cross-replica lookup of a user's machine (daemon) sockets.
 *
 * Why this exists: previewRoutes / previewWebSocketRelay / terminalRelayHandler
 * used to walk `eventRouter.getConnections()`, a process-local Map. With
 * replicas >= 2 a browser request that lands on the replica the daemon is NOT
 * connected to found nothing and answered "Machine offline" — see
 * specs/relay-cross-replica-routing.
 *
 * `io.in(room).fetchSockets()` is answered by every node via the cluster
 * adapter, so it sees daemons on peer replicas too. The room is the one
 * eventRouter already joins machine-scoped sockets to, so there is no second
 * registry to keep in sync.
 */

/** Must stay identical to the room eventRouter.addConnection() joins. */
export function machineRoom(userId: string, machineId: string): string {
    return `user:${userId}:machine:${machineId}`;
}

export type AnyRemoteSocket = RemoteSocket<DefaultEventsMap, any>;

export interface MachineSocketLookup<T> {
    sockets: T[];
    /**
     * True when the cluster lookup itself failed (peer replica unresponsive),
     * so `sockets` may be incomplete. Callers must NOT report this as "the
     * machine is offline" — during the 2026-08-07 outage that misattribution
     * is what made a dead cluster bus look like mass daemon disconnects.
     */
    degraded: boolean;
}

/** Bounded so one unresponsive replica cannot stall a request for the adapter default. */
export const MACHINE_LOOKUP_TIMEOUT_MS = 2_000;

type FetchSocketsIo<T> = {
    in(room: string): { timeout(ms: number): { fetchSockets(): Promise<T[]> } };
};

export async function findMachineSocketsIn<T extends { id: string; data?: any }>(
    io: FetchSocketsIo<T>,
    userId: string,
    machineId: string,
    timeoutMs: number = MACHINE_LOOKUP_TIMEOUT_MS,
): Promise<MachineSocketLookup<T>> {
    let found: T[];
    try {
        found = await io.in(machineRoom(userId, machineId)).timeout(timeoutMs).fetchSockets();
    } catch {
        return { sockets: [], degraded: true };
    }
    // The room should only hold this machine's sockets, but filter anyway:
    // a stale join or a future room-naming change must not route a browser
    // frame into the wrong daemon.
    const sockets = found.filter(
        (s) => s.data?.clientType === 'machine-scoped' && s.data?.machineId === machineId,
    );
    return { sockets, degraded: false };
}

/**
 * Picks the newest live socket of a daemon.
 *
 * A daemon that reconnects after a network flap (sleep/wake, Wi-Fi switch)
 * registers a fresh socket within seconds while happy-server still holds the
 * dead one until engine.io gives up — pingInterval (15s) + pingTimeout (45s).
 * Sending `terminal-open` into the stale socket surfaces only as "Daemon did
 * not acknowledge in time", so the choice matters.
 *
 * The old code took the last entry of an insertion-ordered Set. That signal
 * does not survive `fetchSockets()`, which merges per-replica answers in no
 * defined order — hence the explicit `data.connectedAt` stamp set in
 * socket.ts. Sockets that predate the stamp fall back to the old
 * last-entry-wins behaviour.
 *
 * Caveat: `connectedAt` is each replica's wall clock, so comparing sockets
 * across replicas assumes NTP-level skew (ms). The gap between a stale and a
 * fresh daemon socket is seconds, so this holds.
 */
export function newestMachineSocket<T extends { id: string; data?: any }>(sockets: T[]): T | null {
    let best: T | null = null;
    let bestAt = -Infinity;
    for (const socket of sockets) {
        const at = typeof socket.data?.connectedAt === 'number' ? socket.data.connectedAt : -Infinity;
        // `>=` keeps last-entry-wins among equally-ranked (incl. unstamped) sockets.
        if (at >= bestAt) {
            best = socket;
            bestAt = at;
        }
    }
    return best;
}

export function findMachineSockets(
    io: Server,
    userId: string,
    machineId: string,
    timeoutMs: number = MACHINE_LOOKUP_TIMEOUT_MS,
): Promise<MachineSocketLookup<AnyRemoteSocket>> {
    return findMachineSocketsIn(io as unknown as FetchSocketsIo<AnyRemoteSocket>, userId, machineId, timeoutMs);
}
