/**
 * Remote preview WebSocket relay.
 *
 * The plain `/v1/preview/:machineId/:port/*` route (previewRoutes.ts) is a
 * buffered request/response proxy over a Socket.IO ack — it cannot carry a
 * WebSocket upgrade. This module adds a second, protocol-agnostic path for
 * upgrades (e.g. noVNC → websockify for the Electron GUI preview, or any dev
 * server that speaks WebSocket / HMR):
 *
 *   Browser ──WS upgrade──▶ happy-server (this module)
 *     authenticate ptoken (query or path-scoped cookie)
 *     serialize the raw upgrade request bytes
 *     ──'proxy-ws-open' (emitWithAck)──▶ daemon socket
 *          daemon opens raw TCP to 127.0.0.1:{port}, writes the request bytes
 *     ◀──'proxy-ws-data' (both directions)──▶  raw bytes tunnelled verbatim
 *
 * We deliberately tunnel *raw bytes* rather than parse WebSocket frames: the
 * upstream (websockify / dev server) performs the actual WS handshake with the
 * browser end-to-end through the byte pipe, so `Sec-WebSocket-Accept` matches
 * and any sub-protocol / extension negotiation just works. happy-server never
 * writes its own 101 — the upstream's 101 flows back through the tunnel.
 *
 * Coexistence with Socket.IO: engine.io attaches its own `upgrade` listener for
 * its `/v1/updates` path and, by default, schedules `socket.end()` for any
 * *other* upgrade path after `destroyUpgradeTimeout`. socket.ts passes
 * `destroyUpgrade: false` so engine.io leaves our `/v1/preview/...` upgrades
 * alone; this listener owns them.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket as NetSocket } from "node:net";
import { Socket as IoSocket } from "socket.io";
import { eventRouter } from "@/app/events/eventRouter";
import { verifyPreviewToken } from "@/modules/preview/previewToken";
import { cookieName, readPreviewCookie } from "@/modules/preview/previewCookie";
import { parsePreviewHost } from "@/modules/preview/parsePreviewHost";
import { log } from "@/utils/log";
import type { Fastify } from "@/app/api/types";

// 15s to establish the upstream TCP connection + daemon ack. The tunnel itself
// then lives as long as the WebSocket; there is no idle timeout here because a
// framebuffer stream (VNC) can legitimately sit idle between screen updates.
const WS_OPEN_TIMEOUT_MS = 15_000;

// tunnelId → { browser raw socket, owning daemon socket }. Global map;
// tunnelIds are UUIDs so daemon→server frames dispatch unambiguously. `owner`
// is recorded once the tunnel opens so a machine-socket disconnect can tear
// down exactly its tunnels (see wireMachineSocket).
interface PreviewTunnel {
    socket: NetSocket;
    owner: IoSocket | null;
}
const browserByTunnel = new Map<string, PreviewTunnel>();

// Machine sockets are long-lived and shared across many tunnels; wire the
// daemon→server dispatch listeners exactly once per socket to avoid leaking a
// listener per WebSocket.
const wiredMachineSockets = new WeakSet<IoSocket>();

interface WsFramePayload {
    tunnelId: string;
    dataB64: string;
}

interface PreviewWsMachineSocket {
    id: string;
    timeout(ms: number): {
        emitWithAck(event: string, payload: unknown): Promise<unknown>;
    };
}

export async function openPreviewWsTunnel<T extends PreviewWsMachineSocket>(
    machineSockets: T[],
    payload: { tunnelId: string; port: number; dataB64: string },
    timeoutMs = WS_OPEN_TIMEOUT_MS,
): Promise<T> {
    let lastError: Error | null = null;
    for (const machineSocket of machineSockets) {
        try {
            const ack = (await machineSocket
                .timeout(timeoutMs)
                .emitWithAck('proxy-ws-open', payload)) as { ok?: boolean; code?: string; message?: string } | undefined;
            if (ack?.ok === true) return machineSocket;
            lastError = new Error(ack?.message ?? ack?.code ?? `daemon ${machineSocket.id} refused tunnel`);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }
    throw lastError ?? new Error('No live daemon accepted the preview tunnel');
}

function findMachineSockets(userId: string, machineId: string): IoSocket[] {
    const connections = eventRouter.getConnections(userId);
    if (!connections) return [];
    const sockets: IoSocket[] = [];
    for (const c of connections) {
        if (c.connectionType === 'machine-scoped' && c.machineId === machineId && c.socket.connected) {
            sockets.push(c.socket);
        }
    }
    return sockets;
}

function wireMachineSocket(machineSocket: IoSocket): void {
    if (wiredMachineSockets.has(machineSocket)) return;
    wiredMachineSockets.add(machineSocket);

    machineSocket.on('proxy-ws-data', (payload: WsFramePayload) => {
        const entry = browserByTunnel.get(payload?.tunnelId);
        if (entry && entry.socket.writable) {
            entry.socket.write(Buffer.from(payload.dataB64, 'base64'));
        }
    });

    machineSocket.on('proxy-ws-close', (payload: { tunnelId: string }) => {
        const entry = browserByTunnel.get(payload?.tunnelId);
        if (entry) entry.socket.end();
        browserByTunnel.delete(payload?.tunnelId);
    });

    // When a daemon drops (reconnect, network blip) its live tunnels are dead:
    // the daemon's closeAll() emits land on a disconnected socket, so without
    // this the server would leak the orphaned browser sockets + map entries.
    machineSocket.on('disconnect', () => {
        for (const [tunnelId, entry] of browserByTunnel) {
            if (entry.owner === machineSocket) {
                entry.socket.destroy();
                browserByTunnel.delete(tunnelId);
            }
        }
    });
}

function writeHttpError(socket: NetSocket, status: number, reason: string): void {
    if (socket.writable) {
        // Use socket.end(body) — it flushes the full response before FIN-closing.
        // The previous write()+destroy() could RST before the bytes left the
        // socket, and the bodyless response had no Content-Length; a fronting
        // nginx then turned the auth failure into a generic 502 instead of
        // relaying the real 401/403. Send a proper Content-Length + body so the
        // status reaches the client (e.g. noVNC) cleanly.
        const body = `${status} ${reason}`;
        socket.end(
            `HTTP/1.1 ${status} ${reason}\r\n` +
            `Connection: close\r\n` +
            `Content-Type: text/plain; charset=utf-8\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `\r\n` +
            body,
        );
    } else {
        socket.destroy();
    }
}

/**
 * Serialize an upgrade request back into raw HTTP/1.1 bytes for the daemon to
 * replay against the local upstream. Preserves original header order/case via
 * `rawHeaders`, but rewrites `Host` to the loopback target so name-based vhosts
 * on the dev server resolve correctly.
 */
export function serializeUpgradeRequest(
    method: string,
    upstreamPath: string,
    port: number,
    rawHeaders: string[],
    head: Buffer,
): Buffer {
    let lines = `${method} ${upstreamPath} HTTP/1.1\r\n`;
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        const key = rawHeaders[i];
        const value = key.toLowerCase() === 'host' ? `127.0.0.1:${port}` : rawHeaders[i + 1];
        lines += `${key}: ${value}\r\n`;
    }
    lines += '\r\n';
    const headBuf = head && head.length > 0 ? head : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(lines, 'utf-8'), headBuf]);
}

/**
 * Parse `/v1/preview/:machineId/:port/:subPath?query`. Returns null when the
 * URL is not a preview path so the caller can ignore it (engine.io handles
 * `/v1/updates`).
 */
export function parsePreviewUpgradeUrl(url: string): {
    machineId: string;
    port: number;
    subPath: string;
    query: URLSearchParams;
} | null {
    const match = url.match(/^\/v1\/preview\/([^/]+)\/(\d+)(\/[^?]*)?(?:\?(.*))?$/);
    if (!match) return null;
    const port = Number.parseInt(match[2], 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
        machineId: match[1],
        port,
        subPath: match[3] && match[3].length > 0 ? match[3] : '/',
        query: new URLSearchParams(match[4] ?? ''),
    };
}

/** Raw upgrade requests bypass Fastify's rewriteUrl hook, so origin-isolated
 * preview hosts must be mapped to the canonical route here as well. */
export function parsePreviewUpgradeRequest(url: string, host: string | undefined): ReturnType<typeof parsePreviewUpgradeUrl> {
    const byPath = parsePreviewUpgradeUrl(url);
    if (byPath) return byPath;
    const byHost = parsePreviewHost(host);
    if (!byHost) return null;
    const rawPath = url.startsWith('/') ? url : `/${url}`;
    return parsePreviewUpgradeUrl(`/v1/preview/${byHost.machineId}/${byHost.port}${rawPath}`);
}

export function stripPreviewAuthCookie(
    rawHeaders: string[],
    machineId: string,
    port: number,
): string[] {
    const authName = cookieName(machineId, port);
    const out: string[] = [];
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        const key = rawHeaders[i];
        let value = rawHeaders[i + 1];
        if (key.toLowerCase() === 'cookie') {
            value = value
                .split(';')
                .map((part) => part.trim())
                .filter((part) => !part.startsWith(`${authName}=`))
                .join('; ');
            if (!value) continue;
        }
        out.push(key, value);
    }
    return out;
}

async function handleUpgrade(req: IncomingMessage, socket: NetSocket, head: Buffer): Promise<void> {
    const url = req.url ?? '';
    const parsed = parsePreviewUpgradeRequest(url, req.headers.host);
    if (!parsed) {
        if (url.startsWith('/v1/preview/')) writeHttpError(socket, 400, 'Bad Request');
        return; // not ours — leave for other listeners
    }

    if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
        writeHttpError(socket, 400, 'Bad Request');
        return;
    }

    const { machineId, port, subPath, query } = parsed;

    // Auth: ptoken query (initial vnc.html carried it) or the path-scoped
    // cookie set on the first HTML load. noVNC's websockify connection has no
    // query, so the cookie is the usual carrier here.
    const token = query.get('ptoken') ?? readPreviewCookie(req.headers.cookie, machineId, port);
    if (!token) {
        writeHttpError(socket, 401, 'Unauthorized');
        return;
    }
    const claims = verifyPreviewToken(token);
    if (!claims) {
        writeHttpError(socket, 401, 'Unauthorized');
        return;
    }
    if (claims.machineId !== machineId || claims.port !== port) {
        writeHttpError(socket, 403, 'Forbidden');
        return;
    }

    const machineSockets = findMachineSockets(claims.userId, machineId);
    if (machineSockets.length === 0) {
        writeHttpError(socket, 502, 'Machine Offline');
        return;
    }
    for (const candidate of machineSockets) wireMachineSocket(candidate);

    // Rebuild the upstream path without our ptoken query param.
    query.delete('ptoken');
    const qs = query.toString();
    const upstreamPath = `${subPath}${qs ? `?${qs}` : ''}`;
    const requestBytes = serializeUpgradeRequest(
        req.method ?? 'GET',
        upstreamPath,
        port,
        stripPreviewAuthCookie(req.rawHeaders, machineId, port),
        head,
    );

    const tunnelId = randomUUID();
    // Defense-in-depth: keep the raw socket buffered (it is already paused after
    // an upgrade with no 'data' listener) until the tunnel is open, so no client
    // bytes are lost if anything ever attaches a transient 'data' listener.
    socket.pause();
    browserByTunnel.set(tunnelId, { socket, owner: null });

    let machineSocket: IoSocket;
    try {
        machineSocket = await openPreviewWsTunnel(machineSockets, {
            tunnelId,
            port,
            dataB64: requestBytes.toString('base64'),
        });
    } catch (err) {
        browserByTunnel.delete(tunnelId);
        log({ module: 'preview', level: 'error' }, `proxy-ws-open failed for ${machineId}:${port}: ${(err as Error).message}`);
        writeHttpError(socket, 502, 'Bad Gateway');
        return;
    }

    // The browser may have closed while we were opening the tunnel; if so, tell
    // the daemon to drop the just-opened upstream and stop.
    const entry = browserByTunnel.get(tunnelId);
    if (!entry) {
        machineSocket.emit('proxy-ws-close', { tunnelId });
        return;
    }
    entry.owner = machineSocket;

    // Browser → daemon. Resume the paused socket after wiring the listener so
    // any bytes the client buffered replay here in order.
    socket.on('data', (chunk: Buffer) => {
        machineSocket.emit('proxy-ws-data', { tunnelId, dataB64: chunk.toString('base64') });
    });
    socket.resume();
    const teardown = () => {
        if (browserByTunnel.delete(tunnelId)) {
            machineSocket.emit('proxy-ws-close', { tunnelId });
        }
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
}

export function previewWebSocketRelay(app: Fastify): void {
    app.server.on('upgrade', (req: IncomingMessage, socket: NetSocket, head: Buffer) => {
        handleUpgrade(req, socket, head).catch((err) => {
            log({ module: 'preview', level: 'error' }, `preview upgrade handler crashed: ${(err as Error).message}`);
            try { socket.destroy(); } catch { /* already gone */ }
        });
    });
}
