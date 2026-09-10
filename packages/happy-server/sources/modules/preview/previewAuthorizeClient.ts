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
 * A callback that does not answer is `unavailable`, never `allowed` — the
 * relay decides what to do with that, and under the required policy it fails
 * closed.
 */

export const PREVIEW_AUTHORIZE_PATH = '/api/internal/preview-authorize';

const DEFAULT_TIMEOUT_MS = 3_000;

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

export interface PreviewAuthorizeRequest {
    studioUserId: string;
    projectId: string;
    machineId: string;
    port: number;
}

export type PreviewAuthorizeResult =
    /**
     * `workspacePaths` are the project's directories on that machine, as the
     * studio knows them. The daemon needs them to prove that a plain
     * dev-server process belongs to the project (its cwd must sit inside one),
     * and they must reach it from here — a path supplied by the caller would
     * prove nothing at all.
     */
    | { kind: 'allowed'; workspacePaths: string[] }
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
}): PreviewAuthorizer {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${options.config.origin}${PREVIEW_AUTHORIZE_PATH}`;

    return {
        async authorize(request) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response: Response;
            try {
                response = await options.fetchImpl(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Trusted-Preview-Secret': options.config.secret,
                    },
                    body: JSON.stringify({
                        studioUserId: request.studioUserId,
                        projectId: request.projectId,
                        machineId: request.machineId,
                        port: request.port,
                    }),
                    signal: controller.signal,
                });
            } catch (e) {
                return { kind: 'unavailable', reason: (e as Error).message };
            } finally {
                clearTimeout(timer);
            }

            if (response.status === 401 || response.status === 403 || response.status === 404) {
                return { kind: 'denied' };
            }
            if (!response.ok) {
                return { kind: 'unavailable', reason: `status ${response.status}` };
            }

            let payload: unknown;
            try {
                payload = await response.json();
            } catch {
                return { kind: 'unavailable', reason: 'non-json answer' };
            }
            if (!payload || typeof payload !== 'object' || typeof (payload as { allowed?: unknown }).allowed !== 'boolean') {
                return { kind: 'unavailable', reason: 'malformed answer' };
            }

            const answer = payload as { allowed: boolean; workspacePaths?: unknown };
            const workspacePaths = Array.isArray(answer.workspacePaths)
                ? answer.workspacePaths.filter((entry): entry is string => typeof entry === 'string')
                : [];
            return answer.allowed
                ? { kind: 'allowed', workspacePaths }
                : { kind: 'denied' };
        },
    };
}
