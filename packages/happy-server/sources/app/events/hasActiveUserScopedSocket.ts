import type { Server } from 'socket.io';

/**
 * The room eventRouter.addConnection joins user-scoped sockets to.
 *
 * Single source of truth: both the join (addConnection) and the presence
 * query below derive the name from here, so they cannot drift apart. A
 * drift would make the query silently answer "nobody is watching" forever.
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
