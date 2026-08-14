import type { Server } from 'socket.io';

/**
 * Cross-replica check for whether a user has a human-facing client present.
 *
 * Queries `user:{userId}:user-scoped` — the room eventRouter.addConnection
 * joins only for 'user-scoped' sockets (web-ui, mobile, desktop). Session-
 * scoped sockets (the CLI/agent's own connection for its coding session)
 * and machine-scoped sockets (the daemon) never join this room, so they
 * can't be mistaken for a human looking at a screen — see the 2026-08-14
 * incident where a CLI's own session-scoped socket suppressed the push
 * notification for its own completed turn, and no human client was ever
 * connected to see the realtime update either.
 *
 * "Active" additionally requires the socket hasn't reported
 * `app-state: background`. Old clients that never send it are treated as
 * active (connected = present).
 *
 * Uses fetchSockets() which works cross-replica via the Redis streams
 * adapter.
 */
export async function hasActiveUserScopedSocket(io: Server, userId: string): Promise<boolean> {
    const sockets = await io.in(`user:${userId}:user-scoped`).fetchSockets();
    return sockets.some(s => {
        const appState = s.data.appState as string | undefined;
        return appState !== 'background';
    });
}
