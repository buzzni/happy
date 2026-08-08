/**
 * Registry of active terminal relay sessions. Server-side state for
 * specs/remote-terminal/ Phase 2 — the server is a thin routing layer between
 * the client (web-ui xterm panel) and the daemon (PTY on the user's machine).
 * Payloads are E2EE between the endpoints; this module only tracks routing.
 *
 * Sessions hold **socket ids, not Socket objects**. A Socket instance only
 * exists on the replica that owns the connection, so with replicas >= 2 the
 * daemon's frames arrive on a replica that has no object for the client side.
 * Ids are routable from anywhere: Socket.IO auto-joins every socket to a room
 * named after its id, so `io.to(socketId).emit()` crosses replicas via the
 * cluster adapter. See specs/relay-cross-replica-routing.
 */

export const MAX_TERMINALS_PER_USER = 5;

export interface TerminalSession {
    id: string;
    userId: string;
    machineId: string;
    clientSocketId: string;
    daemonSocketId: string;
    createdAt: number;
}

const sessions = new Map<string, TerminalSession>();

export function addTerminalSession(session: TerminalSession): void {
    sessions.set(session.id, session);
}

export function getTerminalSession(id: string | undefined | null): TerminalSession | null {
    if (!id) return null;
    return sessions.get(id) ?? null;
}

export function removeTerminalSession(id: string): boolean {
    return sessions.delete(id);
}

export function findTerminalSessionsBySocketId(socketId: string): TerminalSession[] {
    const out: TerminalSession[] = [];
    for (const s of sessions.values()) {
        if (s.clientSocketId === socketId || s.daemonSocketId === socketId) {
            out.push(s);
        }
    }
    return out;
}

export function countActiveSessionsForUser(userId: string): number {
    let n = 0;
    for (const s of sessions.values()) {
        if (s.userId === userId) n++;
    }
    return n;
}

/** Test-only — clears the module-scoped session map between tests. */
export function _resetTerminalSessionsForTest(): void {
    sessions.clear();
}
