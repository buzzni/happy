/**
 * engine.io (Socket.IO's transport) claims `request`/`upgrade` traffic
 * purely by path prefix (`/v1/updates`), blind to the Host header — see
 * engine.io's `Server.prototype.attach` (build/server.js). It runs
 * independently of Fastify's `rewriteUrl` hook (api.ts), which is the only
 * place Host-based preview-subdomain dispatch (`<mid>-<port>.preview.
 * <zone>`) normally happens.
 *
 * So a browser loading the studio itself *through* a preview subdomain (the
 * self-preview dev loop) has its own socket.io traffic swallowed by
 * engine.io instead of relayed to the previewed dev server, where the studio
 * actually needs it answered. Every other path is unaffected because
 * Fastify's rewriteUrl already handles it correctly.
 *
 * `attach()` inspects `server.listeners('request')` and `server.on(...)`
 * synchronously at call time — mutating `req.url` before/after doesn't help,
 * since attach() reads the real, current `req.url` inside its own listener
 * with no opportunity for another listener to run first (for `request` it
 * wipes and replaces every existing listener; see the "capture" comments
 * below for exactly what it does).
 *
 * The fix instead wraps the *server object* Socket.IO's `new Server(server,
 * opts)` attaches to, intercepting only the calls attach() makes, so it
 * behaves as if the request/upgrade never matched engine.io's path for the
 * preview-subdomain case:
 *  - `request`: attach() captures the pre-existing (Fastify) listeners via
 *    `.listeners('request')` before wiping them — we stash that same
 *    reference, then in our replacement for `.on('request', engineIoCb)`
 *    call the stashed Fastify listeners ourselves instead of `engineIoCb`
 *    for the bypass case.
 *  - `upgrade`: attach() does not capture/wipe — it stays a co-equal
 *    listener and, given `destroyUpgrade:false` (socket.ts), does nothing
 *    for a non-matching path. We reproduce exactly that "do nothing" for the
 *    bypass case, letting previewWebSocketRelay's own later-registered
 *    `upgrade` listener (on the real, unwrapped server) pick it up.
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import type { Socket as NetSocket } from "node:net";
import type { EventEmitter } from "node:events";
import { parsePreviewHost } from "./parsePreviewHost";

const ENGINE_IO_PATH = '/v1/updates';

function pathMatchesEngineIo(url: string): boolean {
    if (!url.startsWith(ENGINE_IO_PATH)) return false;
    const rest = url.slice(ENGINE_IO_PATH.length);
    return rest === '' || rest.startsWith('/') || rest.startsWith('?');
}

export function shouldBypassEngineIoForPreviewSubdomain(
    url: string | undefined,
    host: string | undefined,
): boolean {
    if (!url || !pathMatchesEngineIo(url)) return false;
    return parsePreviewHost(host) !== null;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
type UpgradeListener = (req: IncomingMessage, socket: NetSocket, head: Buffer) => void;

/**
 * Pass the return value to `new Server(wrapped, opts)` (socket.ts) instead
 * of the real HTTP server. Only `.listeners`/`.on` for `request`/`upgrade`
 * are special-cased; every other property/method (close, address, other
 * events) transparently forwards to the real server.
 */
export function wrapServerForPreviewSubdomainBypass(server: HttpServer): HttpServer {
    let capturedRequestListeners: RequestListener[] = [];

    return new Proxy(server, {
        get(target, prop, receiver) {
            if (prop === 'listeners') {
                return (event: string | symbol) => {
                    const real = target.listeners(event) as RequestListener[];
                    if (event === 'request') capturedRequestListeners = real.slice();
                    return real;
                };
            }
            if (prop === 'on') {
                const on = (target as unknown as EventEmitter).on.bind(target as unknown as EventEmitter);
                return (event: string | symbol, cb: (...args: any[]) => void) => {
                    if (event === 'request') {
                        const wrapped: RequestListener = (req, res) => {
                            if (shouldBypassEngineIoForPreviewSubdomain(req.url, req.headers.host)) {
                                for (const listener of capturedRequestListeners) listener(req, res);
                                return;
                            }
                            cb(req, res);
                        };
                        return on(event, wrapped);
                    }
                    if (event === 'upgrade') {
                        const wrapped: UpgradeListener = (req, socket, head) => {
                            if (shouldBypassEngineIoForPreviewSubdomain(req.url, req.headers.host)) return;
                            cb(req, socket, head);
                        };
                        return on(event, wrapped);
                    }
                    return on(event, cb);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
