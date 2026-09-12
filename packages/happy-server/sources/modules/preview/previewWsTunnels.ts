/**
 * Registry of live preview WebSocket tunnels on this replica, plus the
 * cross-replica hand-off for frames that belong to a different one.
 *
 * Why this is not just a Map: the browser end of a tunnel is a raw TCP socket
 * from an HTTP upgrade, so it exists only on the replica that accepted the
 * upgrade and cannot be addressed through Socket.IO rooms the way a
 * Socket.IO client can (that trick is what fixed the terminal relay). The
 * daemon end is a Socket.IO socket that may live on a *different* replica, and
 * its `proxy-ws-data` events fire only there.
 *
 * So the daemon's replica writes locally when it happens to own the tunnel and
 * otherwise broadcasts to its peers, where the owner picks it up. Broadcast is
 * `io.serverSideEmit` (spec D1 option a): it fans out to every replica, which
 * is wasteful for chatty HMR streams but keeps the code small at 2–3 replicas.
 * If that waste shows up in metrics, swap the injected `broadcast` for a
 * Redis pub/sub channel keyed by owning replica — nothing else has to change.
 *
 * See specs/relay-cross-replica-routing.
 */

import type { Socket as NetSocket } from 'node:net';

export const PREVIEW_WS_DATA = 'preview-ws-data';
export const PREVIEW_WS_CLOSE = 'preview-ws-close';
export const PREVIEW_WS_DAEMON_GONE = 'preview-ws-daemon-gone';

export interface PreviewWsDataMessage { tunnelId: string; dataB64: string; fromDaemonSocketId?: string }
export interface PreviewWsCloseMessage { tunnelId: string }
export interface PreviewWsDaemonGoneMessage { daemonSocketId: string }

/** Emits an event to the *other* replicas (io.serverSideEmit). */
export type BroadcastToReplicas = (event: string, payload: unknown) => void;

interface PreviewTunnel {
    socket: NetSocket;
    /**
     * specs/runtime-isolation-hardening (H3, P1) — the one daemon this tunnel
     * belongs to, known from the moment it is created because tunnel ids are
     * per candidate. Bytes from anyone else are not this tunnel's content.
     */
    daemonSocketId: string;
    /**
     * Whether this tunnel carries a runtime binding. A bound tunnel requires
     * the sender on *every* frame, including one relayed by a peer replica
     * running an older build: treating a missing sender as "compatible" would
     * make the oldest replica in the cluster the way around the same-daemon
     * pin. Unbound tunnels have no such claim to protect and keep working in
     * a mixed-version cluster.
     */
    bound: boolean;
    /**
     * Bytes that arrived before the binding was approved. A daemon starts
     * streaming the upstream's 101 and its first frames as soon as it
     * connects, which can beat its own ack to us — writing those through
     * would mean a tunnel we are about to refuse had already delivered
     * content.
     */
    pending: Buffer[] | null;
    pendingBytes: number;
}

/**
 * How much unapproved data one tunnel may hold. Enough for a handshake and
 * the first frames; past that a daemon is either broken or spending our
 * memory, and the tunnel fails closed rather than growing.
 */
const MAX_PENDING_BYTES = 512 * 1024;

const tunnels = new Map<string, PreviewTunnel>();

export function addTunnel(
    tunnelId: string,
    socket: NetSocket,
    daemonSocketId: string,
    bound = false,
): void {
    tunnels.set(tunnelId, {
        socket,
        daemonSocketId,
        bound,
        pending: [],
        pendingBytes: 0,
    });
}

/**
 * Open the gate for a tunnel whose binding the daemon confirmed, flushing
 * whatever arrived while it was closed. Returns false when the tunnel is gone
 * (browser left, open refused) or the approval came from a daemon this tunnel
 * was not opened with — in both cases nothing is delivered.
 */
export function approveTunnel(tunnelId: string, daemonSocketId: string): boolean {
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel || tunnel.daemonSocketId !== daemonSocketId) return false;
    const pending = tunnel.pending;
    tunnel.pending = null;
    tunnel.pendingBytes = 0;
    if (pending && tunnel.socket.writable) {
        for (const chunk of pending) tunnel.socket.write(chunk);
    }
    return true;
}

export function hasTunnel(tunnelId: string): boolean {
    return tunnels.has(tunnelId);
}

export function deleteTunnel(tunnelId: string): boolean {
    return tunnels.delete(tunnelId);
}

/** Daemon → browser bytes. Writes locally, or hands off to the owning replica. */
export function deliverDaemonData(
    tunnelId: string,
    dataB64: string,
    broadcast: BroadcastToReplicas,
    fromDaemonSocketId: string,
): void {
    if (writeLocal(tunnelId, dataB64, fromDaemonSocketId)) return;
    broadcast(PREVIEW_WS_DATA, { tunnelId, dataB64, fromDaemonSocketId } satisfies PreviewWsDataMessage);
}

/** Daemon → browser close. Closes locally, or hands off to the owning replica. */
export function deliverDaemonClose(tunnelId: string, broadcast: BroadcastToReplicas): void {
    if (closeLocal(tunnelId)) return;
    broadcast(PREVIEW_WS_CLOSE, { tunnelId } satisfies PreviewWsCloseMessage);
}

/** Bytes forwarded from a peer replica. No-op unless this replica owns the tunnel. */
export function applyRemoteData(message: PreviewWsDataMessage): void {
    writeLocal(message?.tunnelId, message?.dataB64, message?.fromDaemonSocketId);
}

/** Close forwarded from a peer replica. No-op unless this replica owns the tunnel. */
export function applyRemoteClose(message: PreviewWsCloseMessage): void {
    closeLocal(message?.tunnelId);
}

/**
 * Tears down the tunnels this replica holds for a daemon socket that has gone
 * away, including the ones still waiting on that daemon's ack. Tunnels opened
 * for a *different* candidate are left alone.
 */
export function dropTunnelsOwnedBy(daemonSocketId: string): string[] {
    const dropped: string[] = [];
    for (const [tunnelId, tunnel] of tunnels) {
        // The candidate is known at registration, so a tunnel still waiting
        // on this daemon's ack is just as dead as an approved one — and it is
        // holding a browser socket.
        if (tunnel.daemonSocketId !== daemonSocketId) continue;
        try { tunnel.socket.destroy(); } catch { /* already gone */ }
        tunnels.delete(tunnelId);
        dropped.push(tunnelId);
    }
    return dropped;
}

function writeLocal(
    tunnelId: string | undefined,
    dataB64: string | undefined,
    fromDaemonSocketId: string | undefined,
): boolean {
    const tunnel = tunnelId ? tunnels.get(tunnelId) : undefined;
    if (!tunnel) return false;
    // Handled here either way: this replica owns the tunnel, so no peer has
    // it and a broadcast could only make another replica guess.
    if (tunnel.bound
        ? fromDaemonSocketId !== tunnel.daemonSocketId
        : fromDaemonSocketId !== undefined && fromDaemonSocketId !== tunnel.daemonSocketId) {
        return true;
    }
    // Owned here, but the socket is already going away: still "handled" — a
    // broadcast would not help, no other replica has this tunnel.
    if (!tunnel.socket.writable) return true;

    const chunk = Buffer.from(dataB64 ?? '', 'base64');
    if (tunnel.pending) {
        tunnel.pendingBytes += chunk.byteLength;
        if (tunnel.pendingBytes > MAX_PENDING_BYTES) {
            // Fail closed: an unapproved tunnel does not get to grow.
            tunnels.delete(tunnelId!);
            try { tunnel.socket.destroy(); } catch { /* already gone */ }
            return true;
        }
        tunnel.pending.push(chunk);
        return true;
    }
    tunnel.socket.write(chunk);
    return true;
}

function closeLocal(tunnelId: string | undefined): boolean {
    const tunnel = tunnelId ? tunnels.get(tunnelId) : undefined;
    if (!tunnel) return false;
    try { tunnel.socket.end(); } catch { /* already gone */ }
    tunnels.delete(tunnelId!);
    return true;
}

/** Test-only — clears the process-local tunnel map (models a fresh replica). */
export function _resetPreviewTunnelsForTest(): void {
    tunnels.clear();
}
