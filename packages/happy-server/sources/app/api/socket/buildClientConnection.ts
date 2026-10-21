import type { Socket } from "socket.io";
import type { ClientConnection } from "@/app/events/eventRouter";

/**
 * The connection record for a socket that has passed the auth middleware.
 *
 * Reads only `socket.data`, never the handshake: a socket restored by
 * connection-state recovery skips the middleware, and its `data` is what the
 * adapter brings back. An unknown or missing `clientType` is a user-scoped
 * connection — older and newer clients alike land on the default.
 */
export function buildClientConnection(socket: Socket): ClientConnection {
    const userId = socket.data.userId as string;
    const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
    const sessionId = socket.data.sessionId as string | undefined;
    const machineId = socket.data.machineId as string | undefined;
    const happyClient = socket.data.happyClient as string | undefined;
    if (clientType === 'session-scoped' && sessionId) {
        return { connectionType: 'session-scoped', socket, userId, sessionId, happyClient };
    }
    if (clientType === 'machine-scoped' && machineId) {
        return { connectionType: 'machine-scoped', socket, userId, machineId, happyClient };
    }
    return socket.data.transportOnly === true
        ? { connectionType: 'user-scoped', socket, userId, happyClient, transportOnly: true }
        : { connectionType: 'user-scoped', socket, userId, happyClient };
}

/**
 * Whether a handshake asked for a send-only user-scoped socket.
 *
 * Only an exact `true` on a user-scoped (or unspecified) client counts. The
 * value is copied to `socket.data` by the auth middleware so a socket restored
 * by connection-state recovery, which skips the middleware, keeps it; session-
 * and machine-scoped sockets never carry it, so no later reader of
 * `socket.data` can misclassify a CLI or daemon socket.
 */
export function transportOnlyFromHandshake(auth: Record<string, unknown>): boolean {
    const clientType = auth.clientType;
    if (clientType !== undefined && clientType !== 'user-scoped') return false;
    return auth.transportOnly === true;
}
