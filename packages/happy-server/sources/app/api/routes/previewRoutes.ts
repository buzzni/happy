/**
 * Remote preview relay routes.
 *
 * Flow:
 *   Browser iframe
 *     ─GET/POST→ /v1/preview/:machineId/:port/*?ptoken=…
 *       (this route)
 *     ─rpc-request→ daemon socket (emitWithAck 'proxy-http')
 *       (daemon relays to 127.0.0.1:{port})
 *     ← ProxyResponse ({ type: 'success'|'error', … })
 *   Response body (+rewriteHtml for text/html) → browser
 *
 * Authentication is intentionally split:
 * - `POST /v1/preview-token` uses the normal Bearer auth + DB check to mint a
 *   short-lived HMAC token bound to (userId, machineId, port).
 * - The preview route itself accepts only the ptoken (iframe src cannot carry
 *   an Authorization header).
 */

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { eventRouter } from "@/app/events/eventRouter";
import { findMachineSockets as findMachineSocketsCrossReplica } from "@/app/events/findMachineSockets";
import {
    signPreviewToken,
    verifyPreviewToken,
    verifyExpiredPreviewTokenForRecovery,
    type PreviewTokenBinding,
} from "@/modules/preview/previewToken";
import {
    type LeaseFailureStatus,
    resolvePreviewBindingPolicy,
    planTrustedMint,
    decideBearerMint,
    type PreviousTokenCheck,
    decideRelayBinding,
    interpretLeaseAck,
    describeLeaseFailure,
    isBindingEnforcementEchoed,
    isStaleRuntimeBinding,
    isRuntimeEvidenceBusy,
    LEASE_UNSUPPORTED_CODE,
    type LeaseAck,
} from "@/modules/preview/previewRuntimeBinding";
import {
    resolvePreviewAuthorizeConfig,
    createPreviewAuthorizer,
    type PreviewAuthorizer,
} from "@/modules/preview/previewAuthorizeClient";
import { readPreviewCookie, buildPreviewCookie } from "@/modules/preview/previewCookie";
import {
    filterUpstreamCookieHeader,
    rewriteSetCookieForPreview,
    splitSetCookieValues,
} from "@/modules/preview/previewCredentials";
import {
    rewriteHtml,
    rewriteJsCss,
    rewriteViteClientForPath,
} from "@/modules/preview/rewriteHtml";
import { rewriteLinkHeader } from "@/modules/preview/rewriteLinkHeader";
import { rewriteLocationHeader } from "@/modules/preview/rewriteLocationHeader";
import { renderExpiredPtokenHtml, shouldServeExpiredHtml } from "@/modules/preview/expiredPtokenHtml";
import { parsePreviewHost } from "@/modules/preview/parsePreviewHost";
import { type Fastify } from "../types";

interface ProxySuccess {
    type: 'success';
    /**
     * specs/runtime-isolation-hardening (H3) — set only by a daemon that
     * actually verified the relayed binding. A daemon predating H3 answers
     * with an otherwise identical envelope, so the absence of this flag is
     * how the relay notices that a bound token was served unchecked.
     */
    bindingEnforced?: boolean;
    status: number;
    // `set-cookie` arrives as an array from current daemons and as a
    // comma-joined string from older ones — see splitSetCookieValues.
    headers: Record<string, string | string[]>;
    bodyB64: string;
    truncated: boolean;
}

interface ProxyError {
    type: 'error';
    code: string;
    message: string;
}

type ProxyRpcResponse = ProxySuccess | ProxyError;

const RPC_TIMEOUT_MS = 35_000;

const ALL_METHODS: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'> =
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface ProxyHttpRequestPayload {
    port: number;
    method: string;
    path: string;
    headers: Record<string, string>;
    bodyB64: string | null;
    /** Runtime the token was minted for; omitted for unbound (legacy) tokens. */
    binding?: { projectId: string; leaseId: string; workspacePaths: string[] };
}

function isProxyRpcResponse(raw: unknown): raw is ProxyRpcResponse {
    if (!raw || typeof raw !== 'object') return false;
    const candidate = raw as Partial<ProxyRpcResponse>;
    return candidate.type === 'success' || candidate.type === 'error';
}

/**
 * Cross-replica: resolves the daemon socket through the Socket.IO room rather
 * than this process's connection map, so a browser request served by a replica
 * the daemon is not connected to still finds it (specs/relay-cross-replica-routing).
 */
function findMachineSockets(userId: string, machineId: string) {
    return findMachineSocketsCrossReplica(eventRouter.server, userId, machineId);
}

/**
 * Minimal shape the relay needs from a daemon socket. Structural on purpose so
 * it accepts both a local `Socket` and a `RemoteSocket` from a cross-replica
 * `fetchSockets()` — their `timeout()` return types differ (`Socket` vs
 * `BroadcastOperator`) but both expose `emitWithAck`, and `RemoteSocket` is
 * built with `expectSingleResponse: true` so the ack shape is identical.
 * Mirrors `PreviewWsMachineSocket` in previewWebSocketRelay.ts.
 */
export interface PreviewRelayMachineSocket {
    id: string;
    timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
}

export async function relayProxyHttpRequest(
    machineSockets: PreviewRelayMachineSocket[],
    payload: ProxyHttpRequestPayload,
    timeoutMs = RPC_TIMEOUT_MS,
): Promise<ProxyRpcResponse> {
    const attempts = machineSockets.map(async (socket) => {
        const raw = await socket
            .timeout(timeoutMs)
            .emitWithAck('proxy-http-request', payload);
        if (!isProxyRpcResponse(raw)) {
            throw new Error(`Malformed proxy response from socket ${socket.id}`);
        }
        return raw;
    });
    return Promise.any(attempts);
}

/**
 * specs/runtime-isolation-hardening (H3, F11) — constant-time comparison of
 * the shared secret. `!==` returns as soon as two bytes differ, which leaks
 * the length of the matching prefix to a caller that can time the endpoint;
 * this route is reachable by anything that can reach the server.
 */
export function matchesTrustedSecret(provided: unknown, expected: string | undefined): boolean {
    if (!expected || typeof provided !== 'string') return false;
    const a = Buffer.from(provided, 'utf-8');
    const b = Buffer.from(expected, 'utf-8');
    // timingSafeEqual throws on a length mismatch, and the length itself is
    // not the secret — compare a fixed-size digest so unequal lengths cost
    // the same as equal ones.
    const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(a), digest(b));
}

/** Decode the replaced token for planTrustedMint — signature required, expiry not. */
function readPreviousToken(previousToken: string | undefined): PreviousTokenCheck {
    if (!previousToken) return { kind: 'absent' };
    const claims = verifyExpiredPreviewTokenForRecovery(previousToken);
    return claims ? { kind: 'token', claims } : { kind: 'invalid' };
}

/** Mint-time lease acquisition is short: an old daemon simply never answers. */
const LEASE_TIMEOUT_MS = 3_000;

/**
 * specs/runtime-isolation-hardening (H3) — ask the daemon which runtime owns
 * the port before signing a token for it.
 *
 * Every failure mode collapses to a typed answer, never to "assume it is
 * fine": a daemon with no handler for this event times out, and that is
 * reported as `RUNTIME_BINDING_UNSUPPORTED` so the caller sees an explicit
 * "update happy-cli" instead of quietly receiving an unbound token.
 */
export async function requestRuntimeLease(
    machineSockets: PreviewRelayMachineSocket[],
    payload: { projectId: string; port: number; workspacePaths: string[] },
    /** Total budget for the whole attempt, not per candidate daemon. */
    timeoutMs = LEASE_TIMEOUT_MS,
): Promise<LeaseAck> {
    const deadline = Date.now() + timeoutMs;
    let lastFailure: LeaseAck | null = null;
    for (const socket of machineSockets) {
        // Reconnects leave stale sockets behind, so the candidate list can be
        // several deep. Retrying each one on its own clock would let a mint
        // (or an open tunnel's recheck) run for a multiple of the budget.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let ack: LeaseAck;
        try {
            ack = interpretLeaseAck(
                await socket.timeout(Math.min(timeoutMs, remaining)).emitWithAck('preview-runtime-lease', payload),
            );
        } catch {
            ack = { type: 'error', code: LEASE_UNSUPPORTED_CODE, message: 'daemon did not answer' };
        }
        if (ack.type === 'success') return ack;
        lastFailure = ack;
    }
    return lastFailure ?? {
        type: 'error',
        code: LEASE_UNSUPPORTED_CODE,
        message: 'no daemon answered the runtime lease request',
    };
}

/**
 * Re-check the studio's project ACL for a bound token. The token proves which
 * runtime it was minted for; it cannot prove the user still has access to the
 * project an hour later, and happy-server has no project tables to answer that
 * itself.
 */
export async function authorizeRelayBinding(input: {
    access: { projectId: string; studioUserId: string };
    machineId: string;
    port: number;
    authorizer: PreviewAuthorizer | null;
}): Promise<
    | { kind: 'allow'; workspacePaths: string[] }
    | { kind: 'reject'; status: number; code: string; message: string }
> {
    const failClosed = {
        kind: 'reject' as const,
        status: 503,
        code: 'authz-unavailable',
        message: 'Project access could not be verified',
    };
    // Fail closed whatever the policy says. The policy decides who must be
    // issued a bound token; it is not a switch that weakens a token that
    // already is one. Substituting `allowed + []` for an unreachable studio
    // would turn an outage of the ACL callback into open access, and the
    // empty workspace list would additionally be a claim — "this project owns
    // no directories here" — that nothing verified.
    if (!input.authorizer) return failClosed;

    const decision = await input.authorizer.authorize({
        studioUserId: input.access.studioUserId,
        projectId: input.access.projectId,
        machineId: input.machineId,
        port: input.port,
    });
    if (decision.kind === 'allowed') return { kind: 'allow', workspacePaths: decision.workspacePaths };
    if (decision.kind === 'denied') {
        return {
            kind: 'reject',
            status: 403,
            code: 'project-access-denied',
            message: 'Project access denied',
        };
    }
    return failClosed;
}

/**
 * Built from operator env on every call — never from a token or a request
 * URL. Resolved per call rather than memoized so that turning the callback on
 * takes effect on the next request instead of the next restart; there is no
 * state to keep, because the authorizer deliberately holds no cache.
 */
export function getPreviewAuthorizer(): PreviewAuthorizer | null {
    const config = resolvePreviewAuthorizeConfig(process.env);
    return config ? createPreviewAuthorizer({ config, fetchImpl: fetch }) : null;
}

/**
 * Build the header set forwarded to the previewed dev server.
 *
 * Only hop-by-hop headers (RFC 7230 §6.1) and `Host` are dropped — the relay
 * is otherwise transparent. In particular `Authorization` and `Cookie` are
 * forwarded: they are the previewed app's own credentials, and stripping them
 * made every authenticated request in the preview fail (the dev server
 * answered 401/redirect, then served its SPA history fallback, so the app's
 * `res.json()` got `index.html`).
 *
 * The one thing that must not cross: the relay's own `happy_preview_*`
 * cookies, which carry the signed ptoken. `filterUpstreamCookieHeader` removes
 * exactly those and leaves the app's cookies alone.
 *
 * `Origin` is passed through here but is NOT transparent end-to-end: the daemon
 * rewrites it to the loopback target before hitting the dev server
 * (previewProxy.ts `buildUpstreamHeaders`, specs/preview-relay-origin-normalization).
 * It is left intact at this layer because the response path still needs the
 * browser's real origin — see `applySubdomainPreviewCorsHeaders`.
 */
export function filterForwardedHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (
            lower === 'host' ||
            lower === 'connection' ||
            lower === 'keep-alive' ||
            lower === 'upgrade' ||
            lower === 'proxy-authenticate' ||
            lower === 'proxy-authorization' ||
            lower === 'te' ||
            lower === 'trailer' ||
            lower === 'transfer-encoding'
        ) continue;
        if (lower === 'cookie') {
            const forwarded = filterUpstreamCookieHeader(
                Array.isArray(value) ? value.join('; ') : value,
            );
            if (forwarded) out[key] = forwarded;
            continue;
        }
        out[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
}

function isPreviewTokenQueryPair(pair: string): boolean {
    const separatorIndex = pair.indexOf('=');
    const rawKey = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
    try {
        return decodeURIComponent(rawKey.replace(/\+/g, ' ')) === 'ptoken';
    } catch {
        return rawKey === 'ptoken';
    }
}

export function buildPreviewUpstreamPath(subPath: string, rawUrl: string): string {
    const queryIndex = rawUrl.indexOf('?');
    if (queryIndex === -1) return `/${subPath}`;

    const query = rawUrl.slice(queryIndex + 1);
    const forwardedQuery = query
        .split('&')
        .filter((pair) => !isPreviewTokenQueryPair(pair))
        .join('&');
    return `/${subPath}${forwardedQuery ? `?${forwardedQuery}` : ''}`;
}

/**
 * specs/preview-relay-502-observability — the relay's two failure branches
 * both answer 502, and the access log (enableMonitoring.ts) records only the
 * route template and duration. That made "the daemon is gone" (abnormal) and
 * "the dev server has not opened its port yet" (normal while booting, and
 * polled for on purpose by web-ui's checkPortReachable) indistinguishable
 * after the fact. This turns each failure into one greppable line.
 *
 * Status mapping is unchanged — 502/504 is a contract with checkPortReachable.
 */
export type PreviewRelayOutcome =
    | { kind: 'machine-offline' }
    /**
     * The cross-replica socket lookup itself failed (peer replica did not
     * answer), so we do not know whether the daemon is there. Same 502 as
     * machine-offline — the checkPortReachable contract is unchanged — but a
     * distinct reason token. Conflating the two is what made the 2026-08-07
     * cluster-bus outage read as mass daemon disconnects.
     * See specs/relay-cross-replica-routing.
     */
    | { kind: 'lookup-degraded' }
    | { kind: 'daemon-error'; code: string; message: string };

export interface PreviewRelayFailureContext {
    method: string;
    machineId: string;
    port: number;
    userId: string;
    /** Upstream path, i.e. `buildPreviewUpstreamPath` output — never the raw URL. */
    path: string;
    candidates: number;
}

export interface PreviewRelayFailure {
    status: number;
    reason: string;
    logLine: string;
}

/**
 * Keep an untrusted value inside the single log line it belongs to. Fastify
 * URI-decodes `params['*']`, so `%0A` in a preview URL arrives as a literal
 * newline; the daemon's error message is likewise arbitrary text. Emitting
 * either verbatim would let a caller forge a second `preview relay failed`
 * line attributed to a machine that is not theirs — the exact forensic signal
 * this line exists to provide.
 */
function escapeLogValue(value: string): string {
    return value.replace(/[\r\n]/g, (ch) => (ch === '\r' ? '\\r' : '\\n'));
}

export function describePreviewRelayFailure(
    outcome: PreviewRelayOutcome,
    ctx: PreviewRelayFailureContext,
): PreviewRelayFailure {
    const status = outcome.kind === 'machine-offline' || outcome.kind === 'lookup-degraded'
        ? 502
        : outcome.code === 'INVALID_PORT' || outcome.code === 'INVALID_PATH' ? 400
            : outcome.code === 'TIMEOUT' ? 504
                // specs/runtime-isolation-hardening (H3) — the daemon refused
                // the relay over the token's runtime binding. That is an
                // authorization answer, not a gateway failure, and 502/504 is
                // a contract with checkPortReachable that must not absorb it.
                // A stale lease (the runtime restarted) is 401 so the caller
                // re-mints; an ownership failure is 403, because re-minting
                // would only produce the same refusal.
                // Backpressure from the daemon's probe queue. Retryable, so
                // it is neither the 403 of an authorization answer nor the
                // 502 that means the dev server could not be reached.
                : isRuntimeEvidenceBusy(outcome.code) ? 503
                    : isStaleRuntimeBinding(outcome.code) ? 401
                        : outcome.code === 'PROJECT_OWNERSHIP_MISMATCH'
                            || outcome.code === 'PORT_PROJECT_MISMATCH'
                            || outcome.code === 'WORKSPACE_UNVERIFIED' ? 403
                            : 502;
    const reason = outcome.kind === 'machine-offline'
        ? 'machine-offline'
        : outcome.kind === 'lookup-degraded'
            ? 'lookup-degraded'
            : `daemon:${outcome.code}`;

    // Backstop for specs/happy-server-log-volume Requirement 4 (never log the
    // signed ptoken). Callers already pass a stripped path; re-running the same
    // filter here keeps one source of truth for what "stripped" means.
    const safePath = escapeLogValue(buildPreviewUpstreamPath(
        ctx.path.replace(/^\//, '').split('?')[0],
        ctx.path,
    ));

    const detail = outcome.kind === 'daemon-error'
        ? ` detail=${escapeLogValue(outcome.message)}`
        : '';
    return {
        status,
        reason,
        logLine: `preview relay failed reason=${reason} status=${status} `
            + `method=${ctx.method} machine=${ctx.machineId} port=${ctx.port} `
            + `user=${ctx.userId} path=${safePath} candidates=${ctx.candidates}${detail}`,
    };
}

export function stripResponseHeaders(
    headers: Record<string, string | string[]>,
    prefix?: string,
): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        // `set-cookie` is the only header the daemon keeps as a list. Pass it
        // through untouched; the route rewrites the entries and merges them
        // with the relay's own cookie once the prefix/secure flags are known.
        if (lower === 'set-cookie') {
            out[key] = value;
            continue;
        }
        // Everything else is single-valued by the time it reaches us, but join
        // defensively so an array-shaped value can't slip past the drop and
        // rewrite rules below.
        const single = Array.isArray(value) ? value.join(', ') : value;
        // Drop headers that don't survive rewriting (Content-Length changes)
        // and frame-ancestor directives that would block iframe embedding.
        if (lower === 'content-length' || lower === 'content-encoding') continue;
        if (lower === 'x-frame-options') continue;
        // For the `Link` header, parse and selectively rewrite: drop
        // `rel=preload` entries (they leak as early-hint preloads against
        // location.origin = the relay host and the HTML body already carries
        // equivalent <link rel="preload"> tags that get prefixed by the
        // rewriter), and rewrite absolute-path URLs in surviving entries
        // (e.g. rel=canonical / rel=manifest) so they route through the
        // proxy. When no entries survive, drop the header entirely.
        // See specs/preview-nextjs-turbopack-hydration/ Phase 3.
        if (lower === 'link') {
            if (!prefix) continue; // Backwards compat: drop when no prefix supplied.
            const rewritten = rewriteLinkHeader(single, prefix);
            if (rewritten === null) continue;
            out[key] = rewritten;
            continue;
        }
        // `Location` (3xx redirects): dev server emits absolute paths
        // (e.g. Next.js `redirect('/admin')`) that the browser would
        // follow against the relay origin → escape to relay host root.
        // Prefix the path so the redirect stays inside the preview mount.
        // See specs/preview-relay-escape-plug/ Phase A.
        if (lower === 'location') {
            out[key] = rewriteLocationHeader(single, prefix ?? '');
            continue;
        }
        out[key] = single;
    }
    return out;
}

function deleteHeaderCaseInsensitive(headers: Record<string, string | string[]>, name: string): void {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === target) delete headers[key];
    }
}

function appendVaryOrigin(headers: Record<string, string | string[]>): void {
    const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'vary');
    if (!existingKey) {
        headers['Vary'] = 'Origin';
        return;
    }
    const existing = Array.isArray(headers[existingKey])
        ? (headers[existingKey] as string[]).join(', ')
        : (headers[existingKey] as string);
    const parts = existing.split(',').map((part) => part.trim().toLowerCase());
    if (!parts.includes('origin')) {
        headers[existingKey] = `${existing}, Origin`;
    }
}

export function applySubdomainPreviewCorsHeaders(
    headers: Record<string, string | string[]>,
    requestOrigin: string | undefined,
    requestHost: string | undefined,
    requestedHeaders?: string,
): Record<string, string | string[]> {
    if (!requestOrigin) return headers;
    let originHost: string;
    try {
        originHost = new URL(requestOrigin).host;
    } catch {
        return headers;
    }
    const originPreview = parsePreviewHost(originHost);
    const targetPreview = parsePreviewHost(requestHost);
    if (!originPreview || !targetPreview) return headers;
    if (originPreview.machineId !== targetPreview.machineId) return headers;

    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Origin');
    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Credentials');
    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Methods');
    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Headers');

    headers['Access-Control-Allow-Origin'] = requestOrigin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = ALL_METHODS.join(', ');
    headers['Access-Control-Allow-Headers'] = requestedHeaders || 'Content-Type, Authorization';
    appendVaryOrigin(headers);
    return headers;
}

/**
 * Mint-time binding: prove the caller may still reach the project, learn its
 * workspace paths from the studio, and have the daemon pin the runtime that is
 * serving the port right now.
 *
 * Every failure is explicit. In particular a daemon that predates H3 answers
 * nothing, which surfaces as `RUNTIME_BINDING_UNSUPPORTED` with instructions
 * to update happy-cli — the one thing it must never do is hand back an
 * unbound token, because that is the downgrade the whole feature exists to
 * prevent.
 */
async function bindMintedToken(input: {
    machineId: string;
    port: number;
    projectId: string;
    studioUserId: string;
    /** Happy account that owns the machine — used only to find its daemon socket. */
    ownerUserId: string;
}): Promise<
    | { kind: 'bound'; bind: PreviewTokenBinding }
    | { kind: 'reject'; status: LeaseFailureStatus; body: { error: string; code: string } }
> {
    // No unbound fallback anywhere below. A request that asked to be bound
    // and could not be is refused, because a token that silently came back
    // weaker than the one requested is indistinguishable, to the caller, from
    // the one it asked for.
    const access = await authorizeRelayBinding({
        access: { projectId: input.projectId, studioUserId: input.studioUserId },
        machineId: input.machineId,
        port: input.port,
        authorizer: getPreviewAuthorizer(),
    });
    if (access.kind === 'reject') {
        return {
            kind: 'reject',
            status: access.status as LeaseFailureStatus,
            body: { error: access.message, code: access.code },
        };
    }

    const { sockets } = await findMachineSockets(input.ownerUserId, input.machineId);
    const lease = await requestRuntimeLease(sockets, {
        projectId: input.projectId,
        port: input.port,
        workspacePaths: access.workspacePaths,
    });
    if (lease.type === 'error') {
        const failure = describeLeaseFailure(lease);
        log(
            { module: 'preview', level: 'warn' },
            `preview mint refused reason=${lease.code} machine=${input.machineId} port=${input.port} project=${input.projectId}`,
        );
        return { kind: 'reject', status: failure.status, body: failure.body };
    }

    return {
        kind: 'bound',
        bind: {
            projectId: input.projectId,
            studioUserId: input.studioUserId,
            leaseId: lease.leaseId,
        },
    };
}

/**
 * specs/runtime-isolation-hardening (H3, P4) — the token this mint replaces.
 *
 * Sent by the re-mint page and forwarded verbatim by the studio. It is not a
 * credential: the studio's own trusted secret authenticates the call, and the
 * caller's authenticated project/user are checked against it. What it carries
 * is the fact that the session being recovered *was bound*, which is the one
 * thing a plain re-mint has no way to know.
 */
const previousTokenBody = {
    previousToken: z.string().min(1).optional(),
};

const mintBindingBody = {
    /** Studio project this token is for. Required once the policy is `required`. */
    projectId: z.string().min(1).optional(),
    /**
     * Studio identity that asked. Deliberately separate from the happy account
     * in `userId`: a company-owned shared machine mints every member's token
     * under one account, so that account can never stand in for the person.
     */
    studioUserId: z.string().min(1).optional(),
};

const mintErrorBody = z.object({ error: z.string(), code: z.string().optional() });

export function previewRoutes(app: Fastify) {
    // Mint a short-lived ptoken that binds (userId, machineId, port) under HMAC.
    app.post('/v1/preview-token', {
        preHandler: app.authenticate,
        schema: {
            // Deliberately without projectId/studioUserId: this path cannot
            // bind, so accepting them would only invite the belief that it
            // does. Zod strips anything else the caller sends.
            body: z.object({
                machineId: z.string().min(1),
                port: z.number().int().min(1).max(65535),
            }),
            response: {
                200: z.object({
                    token: z.string(),
                    expiresAt: z.number(),
                    binding: z.enum(['lease', 'unbound']),
                }),
                403: mintErrorBody,
                404: mintErrorBody,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { machineId, port } = request.body;

        const machine = await db.machine.findFirst({ where: { id: machineId, accountId: userId } });
        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        // specs/runtime-isolation-hardening (H3) — see decideBearerMint. On a
        // company-owned machine every member holds a bearer for the same
        // account, so nothing here identifies the person asking, and a
        // `studioUserId` in the body would be their own claim about
        // themselves. This path mints unbound or refuses.
        const bearer = decideBearerMint(resolvePreviewBindingPolicy(process.env), machineId);
        if (bearer.kind === 'reject') {
            log(
                { module: 'preview', level: 'warn' },
                `preview mint refused reason=${bearer.code} machine=${machineId} port=${port}`,
            );
            return reply.code(bearer.status).send({ error: bearer.message, code: bearer.code });
        }
        const signed = signPreviewToken({ userId, machineId, port });
        log({ module: 'preview', userId, machineId, port }, 'Minted preview token (unbound)');
        return reply.send({ token: signed.token, expiresAt: signed.expiresAt, binding: 'unbound' });
    });

    // Trusted-server mint — bypasses strict accountId ACL.
    //
    // 회사 공유 머신은 그 회사의 sync identity (accountId=A) 로 등록되지만,
    // viewer (회사 멤버) 의 happy account 는 다른 accountId (=B). 위 strict
    // endpoint 는 accountId 매칭만 보므로 viewer 가 직접 호출하면 404.
    //
    // 본 endpoint 는 web-ui server 와 happy-server 간 공유 secret (env
    // `WEB_UI_TRUSTED_PREVIEW_SECRET`) 로만 인증하고, accountId 매칭을
    // skip 한다. 호출자 (web-ui server) 가 자체 권한 검증 (회사 멤버십
    // 확인, canUserAccessProject 등) 을 마쳤다는 신뢰 모델. caller 식별이
    // 필요 없으므로 발급 token 의 `userId` claim 은 machine.accountId 로
    // 박는다 — 후속 relay 흐름 (`/v1/preview/:machineId/:port/*`) 이
    // findMachineSockets(claims.userId, machineId) 로 daemon socket 을
    // 찾는데, 머신 소유자의 accountId 여야 그 socket 이 발견된다.
    //
    // 보안 — secret 은 server-only env. client (브라우저) 노출 X. 이
    // endpoint 는 token-auth preHandler 가 의도적으로 빠져 있다.
    app.post('/v1/preview-token-trusted', {
        schema: {
            body: z.object({
                machineId: z.string().min(1),
                port: z.number().int().min(1).max(65535),
                ...mintBindingBody,
                ...previousTokenBody,
            }),
            response: {
                200: z.object({
                    token: z.string(),
                    expiresAt: z.number(),
                    binding: z.enum(['lease', 'unbound']),
                }),
                400: mintErrorBody,
                401: mintErrorBody,
                403: mintErrorBody,
                404: mintErrorBody,
                409: mintErrorBody,
                502: mintErrorBody,
                503: mintErrorBody,
            },
        },
    }, async (request, reply) => {
        const provided = request.headers['x-trusted-preview-secret'];
        const expected = process.env.WEB_UI_TRUSTED_PREVIEW_SECRET;
        if (!matchesTrustedSecret(provided, expected)) {
            return reply.code(401).send({ error: 'Invalid trusted secret' });
        }
        const { machineId, port, projectId, studioUserId, previousToken } = request.body;
        const machine = await db.machine.findFirst({ where: { id: machineId } });
        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        const plan = planTrustedMint({
            policy: resolvePreviewBindingPolicy(process.env),
            machineId,
            port,
            projectId,
            studioUserId,
            previous: readPreviousToken(previousToken),
        });
        if (plan.kind === 'reject') {
            log(
                { module: 'preview', level: 'warn' },
                `preview mint refused reason=${plan.code} machine=${machineId} port=${port}`,
            );
            return reply.code(plan.status).send({ error: plan.message, code: plan.code });
        }
        if (plan.kind === 'unbound') {
            const signed = signPreviewToken({ userId: machine.accountId, machineId, port });
            log(
                { module: 'preview', trusted: true, userId: machine.accountId, machineId, port },
                `Minted preview token (trusted, unbound: ${plan.reason})`,
            );
            return reply.send({ token: signed.token, expiresAt: signed.expiresAt, binding: 'unbound' });
        }

        const bound = await bindMintedToken({
            machineId,
            port,
            projectId: projectId!,
            studioUserId: studioUserId!,
            ownerUserId: machine.accountId,
        });
        if (bound.kind === 'reject') {
            return reply.code(bound.status).send(bound.body);
        }
        const signed = signPreviewToken({ userId: machine.accountId, machineId, port, bind: bound.bind });
        log(
            { module: 'preview', trusted: true, userId: machine.accountId, machineId, port, projectId, recovered: plan.forced },
            'Minted preview token (trusted, bound)',
        );
        return reply.send({ token: signed.token, expiresAt: signed.expiresAt, binding: 'lease' });
    });

    // Preview relay route lives inside its own encapsulation scope so we can
    // register a raw-buffer content-type parser without affecting other JSON
    // routes on the same app.
    app.register(async (scope) => {
        // Strip inherited built-in parsers (json, urlencoded, etc.) within
        // this scope. addContentTypeParser('*', …) is a *fallback*, not an
        // override — without this, JSON POST bodies are parsed into objects
        // upstream and request.body.length is undefined, so the relay
        // forwards the request with Content-Length set but no body, and the
        // dev server hangs waiting for bytes that never arrive.
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
            done(null, body);
        });

        scope.route({
            method: ALL_METHODS,
            url: '/v1/preview/:machineId/:port/*',
            handler: async (request, reply) => {
                const params = request.params as { machineId: string; port: string; '*'?: string };
                const query = request.query as { ptoken?: string };
                // specs/preview-iframe-origin-isolation-subdomain — when the
                // iframe Host matches `<mid>-<port>.preview.<zone>`,
                // api.ts:rewriteUrl rewrote the URL into this canonical
                // path-prefix shape. We re-parse the Host here to know we
                // came from the subdomain origin (vs an actual path-prefix
                // request to the studio host) so we can disable URL prefix
                // rewriting and emit host-only cookies.
                const previewMode = parsePreviewHost(request.headers.host as string | undefined)
                    ? 'subdomain' as const
                    : 'path-prefix' as const;

                const portNum = Number.parseInt(params.port, 10);
                if (!Number.isInteger(portNum)) {
                    return reply.code(400).send({ error: 'Invalid port' });
                }

                // Phase 9: accept the token from either `?ptoken=` (initial
                // iframe load) or the per-preview cookie (every subsequent
                // subresource once the first response set it). Query wins
                // when both are present — that's the web-ui's refresh path.
                const cookieToken = readPreviewCookie(
                    request.headers.cookie as string | undefined,
                    params.machineId,
                    portNum,
                );
                // specs/remote-preview-relay Phase 10c — when a browser top-
                // level navigation lands on an expired/missing-ptoken URL,
                // respond with a small HTML page whose inline JS re-mints
                // via /api/preview-mint-remote (Phase 10b) and reloads.
                // Non-HTML callers (JSON clients, curl, image subresources)
                // keep getting the existing JSON 401.
                const wantsHtmlFallback = shouldServeExpiredHtml({
                    method: request.method,
                    accept: request.headers.accept as string | undefined,
                    secFetchDest: request.headers['sec-fetch-dest'] as string | undefined,
                    secFetchMode: request.headers['sec-fetch-mode'] as string | undefined,
                });
                const token = query.ptoken ?? cookieToken;
                if (!token) {
                    if (wantsHtmlFallback) {
                        return reply
                            .code(401)
                            .header('Content-Type', 'text/html; charset=utf-8')
                            .send(renderExpiredPtokenHtml({
                                machineId: params.machineId,
                                port: portNum,
                                reason: 'missing',
                            }));
                    }
                    return reply.code(401).send({ error: 'Missing ptoken' });
                }
                const claims = verifyPreviewToken(token);
                if (!claims) {
                    if (wantsHtmlFallback) {
                        return reply
                            .code(401)
                            .header('Content-Type', 'text/html; charset=utf-8')
                            .send(renderExpiredPtokenHtml({
                                machineId: params.machineId,
                                port: portNum,
                                reason: 'expired-or-invalid',
                                // Carries what the replaced session was bound
                                // to, so the re-mint cannot come back weaker.
                                previousToken: token,
                            }));
                    }
                    return reply.code(401).send({ error: 'Invalid or expired ptoken' });
                }
                if (claims.machineId !== params.machineId || claims.port !== portNum) {
                    return reply.code(403).send({ error: 'Token does not match requested machine/port' });
                }

                // specs/runtime-isolation-hardening (H3) — from here on the
                // token's runtime binding decides whether this request may be
                // relayed at all, and the studio ACL is re-checked while we
                // are at it. Both are per request: a token minted an hour ago
                // proves nothing about now.
                const bindingPolicy = resolvePreviewBindingPolicy(process.env);
                const bindingDecision = decideRelayBinding(bindingPolicy, params.machineId, claims);
                if (bindingDecision.kind === 'reject') {
                    log(
                        { module: 'preview', level: 'warn' },
                        `preview relay refused reason=${bindingDecision.code} machine=${params.machineId} port=${portNum}`,
                    );
                    if (wantsHtmlFallback) {
                        // A top-level navigation carrying an unbound token can
                        // recover on its own: the fallback page re-mints, and
                        // that mint now produces a bound token.
                        return reply
                            .code(401)
                            .header('Content-Type', 'text/html; charset=utf-8')
                            .send(renderExpiredPtokenHtml({
                                machineId: params.machineId,
                                port: portNum,
                                reason: 'expired-or-invalid',
                                // Carries what the replaced session was bound
                                // to, so the re-mint cannot come back weaker.
                                previousToken: token,
                            }));
                    }
                    return reply
                        .code(bindingDecision.status)
                        .send({ error: bindingDecision.message, code: bindingDecision.code });
                }

                let relayBinding: ProxyHttpRequestPayload['binding'];
                if (bindingDecision.kind === 'enforce') {
                    const access = await authorizeRelayBinding({
                        access: {
                            projectId: bindingDecision.bind.projectId,
                            studioUserId: bindingDecision.bind.studioUserId,
                        },
                        machineId: params.machineId,
                        port: portNum,
                        authorizer: getPreviewAuthorizer(),
                    });
                    if (access.kind === 'reject') {
                        log(
                            { module: 'preview', level: 'warn' },
                            `preview relay refused reason=${access.code} machine=${params.machineId} port=${portNum} project=${bindingDecision.bind.projectId}`,
                        );
                        return reply.code(access.status).send({ error: access.message, code: access.code });
                    }
                    relayBinding = {
                        projectId: bindingDecision.bind.projectId,
                        leaseId: bindingDecision.bind.leaseId,
                        workspacePaths: access.workspacePaths,
                    };
                }

                if (
                    request.method === 'OPTIONS' &&
                    typeof request.headers['access-control-request-method'] === 'string'
                ) {
                    const outHeaders = applySubdomainPreviewCorsHeaders(
                        {},
                        request.headers.origin as string | undefined,
                        request.headers.host as string | undefined,
                        request.headers['access-control-request-headers'] as string | undefined,
                    );
                    return reply.code(204).headers(outHeaders).send();
                }

                // Build the upstream path (everything after `:port/`) while
                // preserving raw query syntax. Vite virtual modules use
                // valueless flags such as `?svelte&type=style&lang.css`;
                // URLSearchParams would normalize them to `svelte=` and break
                // plugin matching. Strip only the relay auth token.
                //
                // Computed before the socket lookup because the failure logs
                // below must report a ptoken-free path — see
                // specs/preview-relay-502-observability.
                const subPath = params['*'] ?? '';
                const upstreamPath = buildPreviewUpstreamPath(
                    subPath,
                    request.raw.url ?? request.url,
                );

                // Find machine sockets. A daemon reconnect can briefly leave
                // stale machine-scoped connections around; try all live
                // candidates so one stale socket cannot pin preview to a 35s
                // relay timeout while a fresh daemon socket is already ready.
                const { sockets: machineSockets, degraded } = await findMachineSockets(claims.userId, params.machineId);
                const failureContext = {
                    method: request.method,
                    machineId: params.machineId,
                    port: portNum,
                    userId: claims.userId,
                    path: upstreamPath,
                    candidates: machineSockets.length,
                };
                if (machineSockets.length === 0) {
                    // `degraded` means the cross-replica lookup failed, so we do
                    // not know whether the daemon exists. Same 502 either way,
                    // different reason token so the log stays diagnosable.
                    const failure = describePreviewRelayFailure(
                        { kind: degraded ? 'lookup-degraded' : 'machine-offline' },
                        failureContext,
                    );
                    log({ module: 'preview', level: 'warn' }, failure.logLine);
                    return reply.code(failure.status).send({ error: 'Machine offline' });
                }
                if (machineSockets.length > 1) {
                    log({ module: 'preview', level: 'warn' }, `multiple machine sockets for preview relay: user=${claims.userId} machine=${params.machineId} count=${machineSockets.length}`);
                }

                const bodyBuf: Buffer | undefined = request.body as Buffer | undefined;
                const bodyB64 = bodyBuf && bodyBuf.length > 0 ? bodyBuf.toString('base64') : null;

                const forwardHeaders = filterForwardedHeaders(request.headers);

                // Relay via the daemon's plain `proxy-http-request` socket event
                // — deliberately outside the encrypted rpc-request pipeline
                // because happy-server has no access to the machine key and
                // needs to read response bodies to rewrite HTML anyway.
                let rpcResponse: ProxyRpcResponse;
                try {
                    rpcResponse = await relayProxyHttpRequest(machineSockets, {
                        port: portNum,
                        method: request.method,
                        path: upstreamPath,
                        headers: forwardHeaders,
                        bodyB64,
                        ...(relayBinding ? { binding: relayBinding } : {}),
                    });
                } catch (err) {
                    log({ module: 'preview', level: 'error' }, `proxy-http-request relay failed for ${machineSockets.length} candidate(s): ${(err as Error).message}`);
                    return reply.code(504).send({ error: 'Upstream relay timeout' });
                }

                if (rpcResponse.type === 'error') {
                    const failure = describePreviewRelayFailure(
                        { kind: 'daemon-error', code: rpcResponse.code, message: rpcResponse.message },
                        failureContext,
                    );
                    log({ module: 'preview', level: 'warn' }, failure.logLine);
                    if (isStaleRuntimeBinding(rpcResponse.code) && wantsHtmlFallback) {
                        // The dev server restarted under a token that is
                        // otherwise perfectly valid. The re-mint page asks for
                        // a lease over the runtime that is there now.
                        return reply
                            .code(failure.status)
                            .header('Content-Type', 'text/html; charset=utf-8')
                            .send(renderExpiredPtokenHtml({
                                machineId: params.machineId,
                                port: portNum,
                                reason: 'expired-or-invalid',
                                // Carries what the replaced session was bound
                                // to, so the re-mint cannot come back weaker.
                                previousToken: token,
                            }));
                    }
                    return reply.code(failure.status).send({ code: rpcResponse.code, error: rpcResponse.message });
                }

                // The daemon confirms enforcement explicitly. A daemon that
                // predates H3 relays the request and answers with an
                // otherwise identical success envelope, so the missing echo is
                // the only evidence that a bound token was served unchecked —
                // and being unable to tell is not permission to serve it.
                if (relayBinding && !isBindingEnforcementEchoed(rpcResponse)) {
                    log(
                        { module: 'preview', level: 'warn' },
                        `preview relay refused reason=binding-not-enforced machine=${params.machineId} port=${portNum} project=${relayBinding.projectId} — daemon predates runtime binding`,
                    );
                    return reply.code(502).send({
                        error: '이 머신의 daemon 이 프리뷰 런타임 결속을 적용하지 않았습니다. happy-cli 를 업데이트하세요.',
                        code: LEASE_UNSUPPORTED_CODE,
                    });
                }

                // Successful proxy response — rewrite HTML/JS/CSS if applicable.
                // subdomain mode: prefix='' so absolute paths stay on the
                // isolated origin and rewriters become no-ops.
                const prefix = previewMode === 'subdomain'
                    ? ''
                    : `/v1/preview/${params.machineId}/${portNum}`;
                const contentTypeValue = rpcResponse.headers['content-type'] ?? '';
                const contentType = (Array.isArray(contentTypeValue) ? contentTypeValue[0] : contentTypeValue).toLowerCase();
                let responseBody: Buffer = Buffer.from(rpcResponse.bodyB64, 'base64');

                if (contentType.includes('text/html')) {
                    responseBody = Buffer.from(rewriteHtml(responseBody.toString('utf-8'), prefix), 'utf-8');
                } else if (
                    contentType.includes('javascript') ||
                    contentType.includes('typescript') ||
                    contentType.includes('text/css')
                ) {
                    const rewritten = rewriteJsCss(responseBody.toString('utf-8'), prefix);
                    responseBody = Buffer.from(
                        rewriteViteClientForPath(rewritten, prefix, upstreamPath),
                        'utf-8',
                    );
                }

                const outHeaders = stripResponseHeaders(rpcResponse.headers, prefix || undefined);
                if (rpcResponse.truncated) {
                    outHeaders['X-Preview-Truncated'] = '1';
                }
                applySubdomainPreviewCorsHeaders(
                    outHeaders,
                    request.headers.origin as string | undefined,
                    request.headers.host as string | undefined,
                    request.headers['access-control-request-headers'] as string | undefined,
                );
                // Always send fresh Content-Length because the body may have been rewritten.
                outHeaders['Content-Length'] = String(responseBody.length);

                // Phase 9: bake the token into a path-scoped HttpOnly cookie
                // so the iframe's subresource requests authenticate without
                // needing `?ptoken=` in their URLs. Max-Age tracks the signed
                // ptoken's own expiry; the web-ui refreshes the iframe well
                // before expiry (remotePreviewUrl REFRESH_MARGIN_MS = 5min).
                //
                // subdomain mode: Path=/, host-only Domain — cross-preview
                // and studio-vs-preview cookie leakage both blocked.
                // SameSite=None + Secure required for cross-origin iframe
                // subresource requests on HTTPS.
                const maxAgeSeconds = Math.floor(Math.max(0, claims.exp - Date.now()) / 1000);
                // 프로덕션 ingress 는 TLS 를 더 앞단(CDN/ALB)에서 종료하고 뒤로는
                // 평문으로 넘기며 `x-forwarded-proto: http` 를 붙인다(실측). 그
                // 헤더만 믿으면 preview 쿠키가 `SameSite=Lax` 로 발급되는데,
                // 프리뷰는 **항상** 데스크탑/스튜디오 안의 cross-site iframe 이라
                // Chromium 이 Lax 쿠키를 보내지 않는다. 그러면 최초 `?ptoken=`
                // 로드 이후의 모든 요청이 401 이 되고, Accept: text/html 인 요청에는
                // relay 가 "프리뷰 토큰 재발급" HTML 을 돌려줘 앱이 그 HTML 원문을
                // 화면에 덤프한다 — 프리뷰가 아예 안 뜨던 실제 증상.
                //
                // subdomain origin(`<uuid>-<port>.preview.<zone>`)은 프로덕션
                // wildcard DNS/TLS 뒤에서만 존재하므로 브라우저 쪽 연결은 언제나
                // HTTPS 다. 반대로 path-prefix 모드는 로컬 standalone
                // (`http://127.0.0.1:3005/v1/preview/...`)에서도 쓰이므로 거기서
                // Secure 를 강제하면 브라우저가 쿠키를 버린다 — 기존 판정 유지.
                const isHttps = previewMode === 'subdomain'
                    || (request.headers['x-forwarded-proto'] === 'https')
                    || (request.protocol === 'https');
                const previewCookie = buildPreviewCookie(
                    params.machineId,
                    portNum,
                    token,
                    maxAgeSeconds,
                    previewMode === 'subdomain'
                        ? { mode: 'subdomain', sameSite: isHttps ? 'None' : 'Lax', secure: isHttps }
                        : {},
                );
                // The previewed app's own `Set-Cookie` (a login session, say)
                // has to survive alongside the relay cookie. A plain
                // `outHeaders['Set-Cookie'] = …` used to clobber it, because
                // writeHead lower-cases keys and the upstream value lives
                // under `set-cookie` — so cookie-based login could never
                // round-trip. Collect, rewrite for the relay origin, and emit
                // both as a multi-value header.
                const upstreamSetCookies: string[] = [];
                for (const key of Object.keys(outHeaders)) {
                    if (key.toLowerCase() !== 'set-cookie') continue;
                    upstreamSetCookies.push(...splitSetCookieValues(outHeaders[key]));
                    delete outHeaders[key];
                }
                outHeaders['Set-Cookie'] = [
                    ...upstreamSetCookies.map((cookie) =>
                        rewriteSetCookieForPreview(cookie, { prefix, secure: isHttps }),
                    ),
                    previewCookie,
                ];

                reply.raw.writeHead(rpcResponse.status, outHeaders);
                reply.raw.end(responseBody);
            },
        });
    });
}
