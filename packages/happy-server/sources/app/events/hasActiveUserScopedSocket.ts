import type { Server } from 'socket.io';

/**
 * The room eventRouter.addConnection joins user-scoped sockets to.
 *
 * Single source of truth for its three consumers — the join
 * (addConnection), event fan-out (getRoomsForFilter) and the presence
 * query below — so they cannot drift apart. A drift would either split
 * event routing or make the query silently answer "nobody is watching"
 * forever.
 *
 * The returned string is also a wire format: during a rolling deploy old
 * and new replicas share one room via the Redis adapter, so changing it
 * partitions live clients. The spec pins the literal for that reason.
 */
export function userScopedRoom(userId: string): string {
    return `user:${userId}:user-scoped`;
}

/**
 * Cross-replica check for whether a user has a human-facing client present.
 *
 * Queries the user-scoped room, which only user-scoped sockets (web-ui,
 * mobile, desktop) ever join. Session-scoped sockets (the CLI/agent's own
 * connection for its coding session) and machine-scoped sockets (the
 * daemon) are not members, so they can't be mistaken for a human looking
 * at a screen — see the 2026-08-14 incident where a CLI's own
 * session-scoped socket suppressed the push notification for its own
 * completed turn, and no human client was ever connected to see the
 * realtime update either.
 *
 * "Active" additionally requires the socket hasn't reported
 * `app-state: background`. Old clients that never send it are treated as
 * active (connected = present).
 *
 * Uses fetchSockets() which works cross-replica via the Redis streams
 * adapter.
 */
export async function hasActiveUserScopedSocketIn(io: Server, userId: string): Promise<boolean> {
    const sockets = await io.in(userScopedRoom(userId)).fetchSockets();
    return sockets.some(s => {
        const appState = s.data.appState as string | undefined;
        return appState !== 'background';
    });
}
