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
import { Socket as IoSocket, type Server as IoServer } from "socket.io";
import { eventRouter } from "@/app/events/eventRouter";
import { findMachineSockets as findMachineSocketsCrossReplica } from "@/app/events/findMachineSockets";
import {
    addTunnel, setTunnelOwner, deleteTunnel, hasTunnel,
    deliverDaemonData, deliverDaemonClose, dropTunnelsOwnedBy,
    applyRemoteData, applyRemoteClose,
    PREVIEW_WS_DATA, PREVIEW_WS_CLOSE, PREVIEW_WS_DAEMON_GONE,
    type BroadcastToReplicas,
    type PreviewWsDataMessage, type PreviewWsCloseMessage, type PreviewWsDaemonGoneMessage,
} from "@/modules/preview/previewWsTunnels";
import { verifyPreviewToken } from "@/modules/preview/previewToken";
import {
    resolvePreviewBindingPolicy,
    decideRelayBinding,
    isStaleRuntimeBinding,
    isRuntimeEvidenceBusy,
    LEASE_UNSUPPORTED_CODE,
} from "@/modules/preview/previewRuntimeBinding";
import type { PreviewTokenBinding } from "@/modules/preview/previewToken";
import type { PreviewAuthorizer } from "@/modules/preview/previewAuthorizeClient";
import { authorizeRelayBinding, getPreviewAuthorizer, requestRuntimeLease } from "@/app/api/routes/previewRoutes";
import { cookieName, readPreviewCookie } from "@/modules/preview/previewCookie";
import { parsePreviewHost } from "@/modules/preview/parsePreviewHost";
import { log } from "@/utils/log";
import type { Fastify } from "@/app/api/types";

// 15s to establish the upstream TCP connection + daemon ack. The tunnel itself
// then lives as long as the WebSocket; there is no idle timeout here because a
// framebuffer stream (VNC) can legitimately sit idle between screen updates.
const WS_OPEN_TIMEOUT_MS = 15_000;

/**
 * specs/runtime-isolation-hardening (H3) — how often an *open* tunnel is
 * re-checked.
 *
 * The HTTP relay re-verifies per request, which is what makes revocation take
 * effect there. A tunnel has exactly one request — the upgrade — and then
 * lives for hours, so without this it would be the one preview path where
 * losing project access, or the runtime being replaced underneath, changes
 * nothing until the browser reconnects.
 */
export const WS_BINDING_RECHECK_MS = 30_000;

/**
 * Total budget for one recheck — the studio callback and the daemon lease
 * together. Without it the tunnel's termination guarantee would read "one
 * interval plus however long a stalled callback takes", which is not a
 * guarantee. The contract is: an open tunnel whose access or runtime changed
 * is torn down within `WS_BINDING_RECHECK_MS + WS_RECHECK_DEADLINE_MS` of the
 * change, under normal timer scheduling. Data keeps flowing during a check.
 */
export const WS_RECHECK_DEADLINE_MS = 5_000;

/**
 * Carries the daemon's refusal *code* out of the open attempt. The message is
 * free text meant for a human; only the code decides the status.
 */
export class PreviewWsOpenError extends Error {
    constructor(message: string, readonly code: string | null) {
        super(message);
        this.name = 'PreviewWsOpenError';
    }
}

/** Daemon refusals that mean "not this project's runtime", not "gateway broke". */
const BINDING_REFUSAL_CODES = new Set([
    'PROJECT_OWNERSHIP_MISMATCH',
    'PORT_PROJECT_MISMATCH',
    'WORKSPACE_UNVERIFIED',
]);

/**
 * The upgrade never becomes a WebSocket, so this status is all the browser
 * and the operator get. It must say the same thing the HTTP relay says about
 * the same daemon answer: retryable backpressure, a re-mintable stale lease,
 * a refusal, or an ordinary gateway failure.
 */
export function wsOpenFailureStatus(code: string | null): number {
    if (isRuntimeEvidenceBusy(code)) return 503;
    if (code && isStaleRuntimeBinding(code)) return 401;
    if (code && BINDING_REFUSAL_CODES.has(code)) return 403;
    return 502;
}

// Tunnel bookkeeping lives in previewWsTunnels.ts because the browser end is a
// raw TCP socket pinned to this replica while the daemon end may be on another
// one — see that module for the hand-off.

interface WsFramePayload {
    tunnelId: string;
    dataB64: string;
}

interface PreviewWsMachineSocket {
    id: string;
    /** Fire-and-forget channel — used to close a tunnel we are abandoning. */
    emit(event: string, payload: unknown): unknown;
    timeout(ms: number): {
        emitWithAck(event: string, payload: unknown): Promise<unknown>;
    };
}

export async function openPreviewWsTunnel<T extends PreviewWsMachineSocket>(
    machineSockets: T[],
    payload: {
        tunnelId: string;
        port: number;
        dataB64: string;
        /**
         * specs/runtime-isolation-hardening (H3) — same binding the HTTP relay
         * sends. A tunnel is a relayed request too; leaving it unbound would
         * make the upgrade path the way around the binding.
         */
        binding?: { projectId: string; leaseId: string; workspacePaths: string[] };
    },
    /** Total budget for the whole attempt, not per candidate daemon. */
    timeoutMs = WS_OPEN_TIMEOUT_MS,
    requireBindingEnforced = false,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    for (const machineSocket of machineSockets) {
        // Stale sockets left by reconnects mean the candidate list can be
        // several deep; each one must come out of the same budget or a
        // browser waits N × the timeout on an upgrade that will never open.
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            lastError = lastError ?? new PreviewWsOpenError('preview tunnel open timed out', 'TIMEOUT');
            break;
        }
        try {
            const ack = (await machineSocket
                .timeout(Math.min(timeoutMs, remaining))
                .emitWithAck('proxy-ws-open', payload)) as {
                    ok?: boolean;
                    code?: string;
                    message?: string;
                    bindingEnforced?: boolean;
                } | undefined;
            if (ack?.ok === true && (!requireBindingEnforced || ack.bindingEnforced === true)) {
                return machineSocket;
            }
            if (ack?.ok === true) {
                // Opened, but by a daemon that never checked the binding. It
                // is holding a live upstream connection for a tunnel nothing
                // will ever reference again, so close it before moving on.
                machineSocket.emit('proxy-ws-close', { tunnelId: payload.tunnelId });
                lastError = new PreviewWsOpenError(
                    `daemon ${machineSocket.id} opened the tunnel without enforcing the runtime binding`,
                    LEASE_UNSUPPORTED_CODE,
                );
                continue;
            }
            lastError = new PreviewWsOpenError(
                ack?.message ?? ack?.code ?? `daemon ${machineSocket.id} refused tunnel`,
                ack?.code ?? null,
            );
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }
    throw lastError ?? new Error('No live daemon accepted the preview tunnel');
}

/**
 * Re-run the whole binding decision for a tunnel that is already open: the
 * studio ACL, and the runtime the lease was issued over.
 *
 * The lease is re-derived from live evidence rather than remembered, so a
 * container restart or a port handed to another project shows up as a
 * different digest and the tunnel is dropped.
 */
export async function recheckOpenTunnelBinding(input: {
    bind: PreviewTokenBinding;
    machineId: string;
    port: number;
    authorizer: PreviewAuthorizer | null;
    sockets: PreviewWsMachineSocket[];
    deadlineMs?: number;
    requestLease?: typeof requestRuntimeLease;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
    const deadlineMs = input.deadlineMs ?? WS_RECHECK_DEADLINE_MS;
    let expire: NodeJS.Timeout | undefined;
    const expired = new Promise<{ ok: false; reason: string }>((resolve) => {
        expire = setTimeout(() => resolve({ ok: false, reason: 'recheck-deadline' }), deadlineMs);
    });
    try {
        return await Promise.race([runRecheck(input, Date.now() + deadlineMs), expired]);
    } finally {
        clearTimeout(expire);
    }
}

async function runRecheck(
    input: {
        bind: PreviewTokenBinding;
        machineId: string;
        port: number;
        authorizer: PreviewAuthorizer | null;
        sockets: PreviewWsMachineSocket[];
        requestLease?: typeof requestRuntimeLease;
    },
    deadline: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const access = await authorizeRelayBinding({
        access: { projectId: input.bind.projectId, studioUserId: input.bind.studioUserId },
        machineId: input.machineId,
        port: input.port,
        authorizer: input.authorizer,
    });
    if (access.kind === 'reject') return { ok: false, reason: access.code };

    // Whatever the ACL check already spent comes out of the same budget.
    const lease = await (input.requestLease ?? requestRuntimeLease)(
        input.sockets,
        { projectId: input.bind.projectId, port: input.port, workspacePaths: access.workspacePaths },
        Math.max(1, deadline - Date.now()),
    );
    if (lease.type === 'error') return { ok: false, reason: lease.code };
    if (lease.leaseId !== input.bind.leaseId) return { ok: false, reason: 'LEASE_MISMATCH' };
    return { ok: true };
}

/**
 * Keep an open tunnel honest for as long as it lives.
 *
 * A tunnel makes exactly one request — the upgrade — and then carries bytes
 * for hours. Everything the HTTP relay re-checks per request has to happen
 * here on a timer, or the upgrade path becomes the way to hold access that
 * was taken away. Three things end a tunnel: the token's own expiry, a failed
 * recheck, and the browser going away.
 *
 * The recheck is pinned to the daemon that actually accepted this upgrade.
 * Re-resolving the machine's sockets would let a different daemon answer for
 * a tunnel it is not carrying, and its answer would say nothing about the
 * runtime these bytes are flowing to.
 */
export function armTunnelRevocation(input: {
    tunnelId: string;
    bind: PreviewTokenBinding;
    machineId: string;
    port: number;
    /** Token expiry, epoch ms. */
    expiresAt: number;
    daemon: PreviewWsMachineSocket;
    isOpen: () => boolean;
    revoke: (reason: string) => void;
    intervalMs?: number;
    deadlineMs?: number;
    recheck?: typeof recheckOpenTunnelBinding;
}): () => void {
    const recheck = input.recheck ?? recheckOpenTunnelBinding;
    let stopped = false;
    let inFlight = false;
    let interval: NodeJS.Timeout | null = null;
    let expiry: NodeJS.Timeout | null = null;

    const stop = () => {
        stopped = true;
        if (interval) clearInterval(interval);
        if (expiry) clearTimeout(expiry);
        interval = null;
        expiry = null;
    };
    const end = (reason: string) => {
        if (stopped) return;
        stop();
        input.revoke(reason);
    };

    expiry = setTimeout(() => end('token-expired'), Math.max(0, input.expiresAt - Date.now()));
    expiry.unref?.();

    interval = setInterval(() => {
        if (stopped) return;
        if (!input.isOpen()) {
            stop();
            return;
        }
        // One check at a time. A slow callback must not stack another check
        // on top of it every interval.
        if (inFlight) return;
        inFlight = true;
        void (async () => {
            let verdict: { ok: true } | { ok: false; reason: string };
            try {
                verdict = await recheck({
                    bind: input.bind,
                    machineId: input.machineId,
                    port: input.port,
                    authorizer: getPreviewAuthorizer(),
                    sockets: [input.daemon],
                    deadlineMs: input.deadlineMs,
                });
            } catch (err) {
                // The check itself broke. Keeping the tunnel would make an
                // outage of this path the way to keep access.
                verdict = { ok: false, reason: `recheck-failed: ${(err as Error).message}` };
            } finally {
                inFlight = false;
            }
            if (verdict.ok) return;
            end(verdict.reason);
        })();
    }, input.intervalMs ?? WS_BINDING_RECHECK_MS);
    // Never hold the process open for a check.
    interval.unref?.();

    return stop;
}

/** Cross-replica: the daemon may be attached to a different pod than this upgrade. */
function findMachineSockets(userId: string, machineId: string) {
    return findMachineSocketsCrossReplica(eventRouter.server, userId, machineId);
}

/**
 * Daemon-side dispatch, registered on every machine-scoped socket at connection
 * time (socket.ts). It has to live on the daemon's own replica: `proxy-ws-*`
 * events fire only there, and a RemoteSocket cannot take listeners at all.
 * The tunnel it refers to may be owned by a peer replica, so delivery goes
 * through previewWsTunnels' local-or-broadcast hand-off.
 */
export function previewWsMachineHandler(machineSocket: IoSocket): void {
    const broadcast: BroadcastToReplicas = (event, payload) => {
        eventRouter.server.serverSideEmit(event as any, payload as any);
    };

    machineSocket.on('proxy-ws-data', (payload: WsFramePayload) => {
        deliverDaemonData(payload?.tunnelId, payload?.dataB64, broadcast);
    });

    machineSocket.on('proxy-ws-close', (payload: { tunnelId: string }) => {
        deliverDaemonClose(payload?.tunnelId, broadcast);
    });

    // When a daemon drops (reconnect, network blip) its live tunnels are dead:
    // the daemon's closeAll() emits land on a disconnected socket, so without
    // this the server would leak the orphaned browser sockets + map entries.
    // Peers must sweep too — the browser socket can be on any replica.
    machineSocket.on('disconnect', () => {
        dropTunnelsOwnedBy(machineSocket.id);
        broadcast(PREVIEW_WS_DAEMON_GONE, { daemonSocketId: machineSocket.id });
    });
}

/**
 * Peer-replica listeners. Registered once per process (socket.ts) so frames
 * handed over by another replica reach the browser socket we own.
 */
export function registerPreviewWsClusterListeners(io: IoServer): void {
    io.on(PREVIEW_WS_DATA as any, (message: PreviewWsDataMessage) => applyRemoteData(message));
    io.on(PREVIEW_WS_CLOSE as any, (message: PreviewWsCloseMessage) => applyRemoteClose(message));
    io.on(PREVIEW_WS_DAEMON_GONE as any, (message: PreviewWsDaemonGoneMessage) => {
        dropTunnelsOwnedBy(message?.daemonSocketId);
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
 * on the dev server resolve correctly. `Origin` is rewritten the same way
 * (specs/preview-relay-origin-normalization) — otherwise it stays the preview
 * domain while `Host` becomes loopback, and any dev-server WS handler that
 * compares the two (Vite/webpack HMR, Expo Metro) rejects the handshake as
 * cross-origin.
 */
export function serializeUpgradeRequest(
    method: string,
    upstreamPath: string,
    port: number,
    rawHeaders: string[],
    head: Buffer,
): Buffer {
    const loopback = `127.0.0.1:${port}`;
    let lines = `${method} ${upstreamPath} HTTP/1.1\r\n`;
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        const key = rawHeaders[i];
        const lower = key.toLowerCase();
        const value =
            lower === 'host' ? loopback :
            lower === 'origin' ? `http://${loopback}` :
            rawHeaders[i + 1];
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

    // specs/runtime-isolation-hardening (H3) — the upgrade path gets the same
    // treatment as the HTTP relay: the token's runtime binding decides whether
    // this tunnel may open, and the studio ACL is re-checked here too.
    const bindingPolicy = resolvePreviewBindingPolicy(process.env);
    const bindingDecision = decideRelayBinding(bindingPolicy, machineId, claims);
    if (bindingDecision.kind === 'reject') {
        log({ module: 'preview', level: 'warn' },
            `preview ws refused reason=${bindingDecision.code} machine=${machineId} port=${port}`);
        writeHttpError(socket, bindingDecision.status, 'Unauthorized');
        return;
    }
    let wsBinding: { projectId: string; leaseId: string; workspacePaths: string[] } | undefined;
    if (bindingDecision.kind === 'enforce') {
        const access = await authorizeRelayBinding({
            access: {
                projectId: bindingDecision.bind.projectId,
                studioUserId: bindingDecision.bind.studioUserId,
            },
            machineId,
            port,
            authorizer: getPreviewAuthorizer(),
        });
        if (access.kind === 'reject') {
            log({ module: 'preview', level: 'warn' },
                `preview ws refused reason=${access.code} machine=${machineId} port=${port} project=${bindingDecision.bind.projectId}`);
            writeHttpError(socket, access.status, 'Forbidden');
            return;
        }
        wsBinding = {
            projectId: bindingDecision.bind.projectId,
            leaseId: bindingDecision.bind.leaseId,
            workspacePaths: access.workspacePaths,
        };
    }

    const { sockets: machineSockets, degraded } = await findMachineSockets(claims.userId, machineId);
    if (machineSockets.length === 0) {
        // `degraded` = the cross-replica lookup failed, so we do not know
        // whether the daemon is there. Same 502, distinct log line.
        if (degraded) {
            log({ module: 'preview', level: 'error' },
                `preview ws lookup degraded machine=${machineId} port=${port} — cluster bus did not answer`);
        }
        writeHttpError(socket, 502, 'Machine Offline');
        return;
    }

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
    addTunnel(tunnelId, socket);

    let chosenSocket: (typeof machineSockets)[number];
    try {
        chosenSocket = await openPreviewWsTunnel(
            machineSockets,
            {
                tunnelId,
                port,
                dataB64: requestBytes.toString('base64'),
                ...(wsBinding ? { binding: wsBinding } : {}),
            },
            undefined,
            Boolean(wsBinding),
        );
    } catch (err) {
        deleteTunnel(tunnelId);
        const code = err instanceof PreviewWsOpenError ? err.code : null;
        log({ module: 'preview', level: 'error' }, `proxy-ws-open failed for ${machineId}:${port}: ${(err as Error).message}`);
        writeHttpError(socket, wsOpenFailureStatus(code), 'Bad Gateway');
        return;
    }

    // Browser → daemon. Addressed by socket id so it lands on whichever replica
    // owns the daemon (Socket.IO auto-joins every socket to a room named after
    // its id).
    const daemonSocketId = chosenSocket.id;
    const toDaemon = (event: string, payload: unknown) =>
        eventRouter.server.to(daemonSocketId).emit(event as any, payload as any);

    // The browser may have closed while we were opening the tunnel; if so, tell
    // the daemon to drop the just-opened upstream and stop.
    if (!hasTunnel(tunnelId)) {
        toDaemon('proxy-ws-close', { tunnelId });
        return;
    }
    setTunnelOwner(tunnelId, daemonSocketId);

    // Resume the paused socket after wiring the listener so any bytes the
    // client buffered replay here in order.
    socket.on('data', (chunk: Buffer) => {
        toDaemon('proxy-ws-data', { tunnelId, dataB64: chunk.toString('base64') });
    });
    socket.resume();
    let stopRevocation: (() => void) | null = null;
    const teardown = () => {
        stopRevocation?.();
        stopRevocation = null;
        if (deleteTunnel(tunnelId)) {
            toDaemon('proxy-ws-close', { tunnelId });
        }
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    // Revocation for a connection that is already open. Access can be taken
    // away, and the runtime can be replaced, long after the upgrade — the
    // tunnel is the only preview path where nothing else would notice.
    if (bindingDecision.kind === 'enforce') {
        stopRevocation = armTunnelRevocation({
            tunnelId,
            bind: bindingDecision.bind,
            machineId,
            port,
            expiresAt: claims.exp,
            // The daemon that accepted this upgrade, not whichever socket the
            // machine happens to have later.
            daemon: chosenSocket,
            isOpen: () => hasTunnel(tunnelId),
            revoke: (reason) => {
                log({ module: 'preview', level: 'warn' },
                    `preview ws revoked reason=${reason} machine=${machineId} port=${port} project=${bindingDecision.bind.projectId}`);
                teardown();
                try { socket.destroy(); } catch { /* already gone */ }
            },
        });
    }
}

export function previewWebSocketRelay(app: Fastify): void {
    app.server.on('upgrade', (req: IncomingMessage, socket: NetSocket, head: Buffer) => {
        handleUpgrade(req, socket, head).catch((err) => {
            log({ module: 'preview', level: 'error' }, `preview upgrade handler crashed: ${(err as Error).message}`);
            try { socket.destroy(); } catch { /* already gone */ }
        });
    });
}
