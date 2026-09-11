/**
 * specs/runtime-isolation-hardening (H3) — per-request re-check of the
 * studio's project ACL.
 *
 * The preview token proves *what* runtime it was minted for; it cannot prove
 * that the studio user still has access to that project an hour later
 * (removed from the company, project transferred, access revoked). happy-server
 * has no project tables of its own and must not grow any, so it asks the
 * studio — the ACL owner — over a small authenticated callback.
 *
 * SSRF: the target is built from operator env only (`PREVIEW_AUTHZ_ORIGIN`)
 * and never from the token, the request URL, or any caller-supplied value.
 * Authentication reuses the existing `WEB_UI_TRUSTED_PREVIEW_SECRET` shared
 * between the two servers.
 *
 * A callback that does not answer is `unavailable`, never `allowed`, and the
 * relay fails closed on that.
 *
 * Only one answer is a decision: HTTP 200 carrying the contract body. A 401,
 * 403 or 404 means *our* secret, origin or path is wrong — reading those as
 * "the user may not have this" would turn our own misconfiguration into a
 * silent, permanent denial for everyone, which is the failure this module is
 * least able to notice from the inside.
 */

export const PREVIEW_AUTHORIZE_PATH = '/api/internal/preview-authorize';

/** Covers the whole exchange — connect, headers, body read and parse. */
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * The contract answer is a boolean and a handful of paths. Anything larger is
 * not a slow studio, it is the wrong endpoint or a broken one, and buffering
 * it would let a single answer consume the relay's memory.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface PreviewAuthorizeConfig {
    origin: string;
    secret: string;
}

export function resolvePreviewAuthorizeConfig(
    env: Record<string, string | undefined>,
): PreviewAuthorizeConfig | null {
    const rawOrigin = (env.PREVIEW_AUTHZ_ORIGIN ?? '').trim();
    const secret = (env.WEB_UI_TRUSTED_PREVIEW_SECRET ?? '').trim();
    if (!rawOrigin || !secret) return null;
    let parsed: URL;
    try {
        parsed = new URL(rawOrigin);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return { origin: parsed.origin, secret };
}

export interface PreviewAuthorizeProjectRequest {
    studioUserId: string;
    projectId: string;
    machineId: string;
    port: number;
}

/**
 * specs/runtime-isolation-hardening (H3 viewer purpose) — the machine-scoped
 * question. The studio answers it with `canUserAccessMachine` **and** by
 * re-deriving the viewer key for this user on this machine: machine access
 * alone would let anyone who may reach a shared machine ride another user's
 * viewer, because "may open a screen here" and "owns this screen" are
 * different facts.
 */
export interface PreviewAuthorizeViewerRequest {
    purpose: 'viewer';
    studioUserId: string;
    viewerKey: string;
    machineId: string;
    port: number;
}

export type PreviewAuthorizeRequest =
    | PreviewAuthorizeProjectRequest
    | PreviewAuthorizeViewerRequest;

export type PreviewAuthorizeResult =
    /**
     * `workspacePaths` are the project's directories on that machine, as the
     * studio knows them. The daemon needs them to prove that a plain
     * dev-server process belongs to the project (its cwd must sit inside one),
     * and they must reach it from here — a path supplied by the caller would
     * prove nothing at all.
     */
    | { kind: 'allowed'; workspacePaths: string[]; viewerKey?: string }
    | { kind: 'denied' }
    | { kind: 'unavailable'; reason: string };

export interface PreviewAuthorizer {
    authorize(request: PreviewAuthorizeRequest): Promise<PreviewAuthorizeResult>;
}

/**
 * Deliberately without a cache. Every relayed request re-asks the studio: a
 * cached decision is a revocation window, and a preview URL that keeps
 * working for another ten seconds after access was removed is exactly the
 * behaviour this callback exists to remove. The same reasoning applies to the
 * daemon's runtime probe, which is likewise re-run per request.
 */
export function createPreviewAuthorizer(options: {
    config: PreviewAuthorizeConfig;
    fetchImpl: typeof fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
}): PreviewAuthorizer {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const url = `${options.config.origin}${PREVIEW_AUTHORIZE_PATH}`;
    const unavailable = (reason: string): PreviewAuthorizeResult => ({
        kind: 'unavailable',
        reason: redactSecret(reason, options.config.secret),
    });

    return {
        async authorize(request) {
            // One deadline for the whole exchange. Aborting only the connect
            // phase would leave a callback that sends headers and then stops
            // holding a preview request open indefinitely.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await options.fetchImpl(url, {
                    method: 'POST',
                    // Never follow a redirect: it would re-send the shared
                    // secret to whatever host the answer names.
                    redirect: 'error',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Trusted-Preview-Secret': options.config.secret,
                    },
                    body: JSON.stringify(
                        isViewerRequest(request)
                            ? {
                                purpose: 'viewer',
                                studioUserId: request.studioUserId,
                                viewerKey: request.viewerKey,
                                machineId: request.machineId,
                                port: request.port,
                            }
                            : {
                                studioUserId: request.studioUserId,
                                projectId: request.projectId,
                                machineId: request.machineId,
                                port: request.port,
                            },
                    ),
                    signal: controller.signal,
                });

                if (response.status !== 200) {
                    await response.body?.cancel().catch(() => { /* nothing to drain */ });
                    return unavailable(`status ${response.status}`);
                }

                const body = await readBounded(response, maxResponseBytes);
                if (body === null) return unavailable('answer exceeded the response limit');

                let payload: unknown;
                try {
                    payload = JSON.parse(body);
                } catch {
                    return unavailable('non-json answer');
                }
                if (isViewerRequest(request)) {
                    const viewer = parseViewerAuthorizeAnswer(payload);
                    if (!viewer) return unavailable('malformed answer');
                    if (!viewer.allowed) return { kind: 'denied' };
                    // The key the studio re-derived has to be the key the
                    // token carries. An `allowed` that names a different
                    // viewer is an answer to a different question, so it is
                    // not an authorization at all.
                    if (viewer.viewerKey !== request.viewerKey) {
                        return unavailable('answer named a different viewer key');
                    }
                    return { kind: 'allowed', workspacePaths: [], viewerKey: viewer.viewerKey };
                }
                const answer = parseAuthorizeAnswer(payload);
                if (!answer) return unavailable('malformed answer');
                return answer.allowed
                    ? { kind: 'allowed', workspacePaths: answer.workspacePaths }
                    : { kind: 'denied' };
            } catch (e) {
                return unavailable((e as Error).message);
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

/** Keep the shared secret out of anything that can reach a log line. */
function redactSecret(text: string, secret: string): string {
    const cleaned = secret ? text.split(secret).join('[redacted]') : text;
    return cleaned.slice(0, 200);
}

/**
 * Read the body with a hard byte ceiling, streaming so an oversized answer is
 * refused while it arrives rather than after it has all been buffered.
 * Returns null when the limit is exceeded.
 */
async function readBounded(response: Response, limit: number): Promise<string | null> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => { /* already gone */ });
            return null;
        }
        chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
}

/**
 * Strict: the answer is either exactly the contract or it is not an answer.
 *
 * `workspacePaths` in particular is not filtered — dropping the entries we
 * cannot read would silently narrow the project's verified directories, and
 * the daemon would then refuse a dev server that does belong to it for a
 * reason nobody could trace back to here.
 */
function parseAuthorizeAnswer(payload: unknown): { allowed: boolean; workspacePaths: string[] } | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const candidate = payload as { allowed?: unknown; workspacePaths?: unknown };
    if (typeof candidate.allowed !== 'boolean') return null;
    if (candidate.workspacePaths === undefined) {
        return { allowed: candidate.allowed, workspacePaths: [] };
    }
    if (!Array.isArray(candidate.workspacePaths)) return null;
    for (const entry of candidate.workspacePaths) {
        if (typeof entry !== 'string' || !isAbsoluteWorkspacePath(entry)) return null;
    }
    return { allowed: candidate.allowed, workspacePaths: candidate.workspacePaths as string[] };
}

export function isViewerRequest(
    request: PreviewAuthorizeRequest,
): request is PreviewAuthorizeViewerRequest {
    return (request as PreviewAuthorizeViewerRequest).purpose === 'viewer';
}

const VIEWER_KEY_PATTERN = /^bv1_[A-Za-z0-9_-]{32}$/;

/**
 * The viewer contract is `{allowed:false}` or `{allowed:true, viewerKey}` —
 * nothing else. `workspacePaths` is refused rather than ignored: a viewer has
 * no project directories, so an answer carrying them is answering about
 * something else, and quietly dropping the field would hide that.
 */
function parseViewerAuthorizeAnswer(
    payload: unknown,
): { allowed: false } | { allowed: true; viewerKey: string } | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const candidate = payload as { allowed?: unknown; viewerKey?: unknown; workspacePaths?: unknown };
    if (typeof candidate.allowed !== 'boolean') return null;
    if (candidate.workspacePaths !== undefined) return null;
    if (!candidate.allowed) return { allowed: false };
    if (typeof candidate.viewerKey !== 'string' || !VIEWER_KEY_PATTERN.test(candidate.viewerKey)) return null;
    return { allowed: true, viewerKey: candidate.viewerKey };
}

/**
 * The daemon resolves these against the filesystem, so a relative path would
 * be resolved against *its* working directory — a directory the studio never
 * meant. Both POSIX and Windows forms are accepted because the daemon, not
 * this server, decides which platform it is on.
 */
function isAbsoluteWorkspacePath(entry: string): boolean {
    if (entry.length === 0 || entry.includes('\0')) return false;
    return entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith('\\\\');
}
