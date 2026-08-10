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

export interface PreviewWsDataMessage { tunnelId: string; dataB64: string }
export interface PreviewWsCloseMessage { tunnelId: string }
export interface PreviewWsDaemonGoneMessage { daemonSocketId: string }

/** Emits an event to the *other* replicas (io.serverSideEmit). */
export type BroadcastToReplicas = (event: string, payload: unknown) => void;

interface PreviewTunnel {
    socket: NetSocket;
    /** Daemon socket id; null until proxy-ws-open is acked. */
    ownerSocketId: string | null;
}

const tunnels = new Map<string, PreviewTunnel>();

export function addTunnel(tunnelId: string, socket: NetSocket): void {
    tunnels.set(tunnelId, { socket, ownerSocketId: null });
}

export function setTunnelOwner(tunnelId: string, ownerSocketId: string): void {
    const tunnel = tunnels.get(tunnelId);
    if (tunnel) tunnel.ownerSocketId = ownerSocketId;
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
): void {
    if (writeLocal(tunnelId, dataB64)) return;
    broadcast(PREVIEW_WS_DATA, { tunnelId, dataB64 } satisfies PreviewWsDataMessage);
}

/** Daemon → browser close. Closes locally, or hands off to the owning replica. */
export function deliverDaemonClose(tunnelId: string, broadcast: BroadcastToReplicas): void {
    if (closeLocal(tunnelId)) return;
    broadcast(PREVIEW_WS_CLOSE, { tunnelId } satisfies PreviewWsCloseMessage);
}

/** Bytes forwarded from a peer replica. No-op unless this replica owns the tunnel. */
export function applyRemoteData(message: PreviewWsDataMessage): void {
    writeLocal(message?.tunnelId, message?.dataB64);
}

/** Close forwarded from a peer replica. No-op unless this replica owns the tunnel. */
export function applyRemoteClose(message: PreviewWsCloseMessage): void {
    closeLocal(message?.tunnelId);
}

/**
 * Tears down the tunnels this replica holds for a daemon socket that has gone
 * away. Tunnels still opening (no owner yet) are left alone — their owner is
 * not known to be this daemon.
 */
export function dropTunnelsOwnedBy(daemonSocketId: string): string[] {
    const dropped: string[] = [];
    for (const [tunnelId, tunnel] of tunnels) {
        if (tunnel.ownerSocketId !== daemonSocketId) continue;
        try { tunnel.socket.destroy(); } catch { /* already gone */ }
        tunnels.delete(tunnelId);
        dropped.push(tunnelId);
    }
    return dropped;
}

function writeLocal(tunnelId: string | undefined, dataB64: string | undefined): boolean {
    const tunnel = tunnelId ? tunnels.get(tunnelId) : undefined;
    if (!tunnel) return false;
    // Owned here, but the socket is already going away: still "handled" — a
    // broadcast would not help, no other replica has this tunnel.
    if (!tunnel.socket.writable) return true;
    tunnel.socket.write(Buffer.from(dataB64 ?? '', 'base64'));
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
