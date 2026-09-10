import { describe, it, expect, vi } from 'vitest';
import {
    resolvePreviewAuthorizeConfig,
    createPreviewAuthorizer,
    PREVIEW_AUTHORIZE_PATH,
} from '@/modules/preview/previewAuthorizeClient';

const CONFIG = { origin: 'https://studio.internal', secret: 'shared-secret' };

const REQUEST = {
    studioUserId: 'studio-1',
    projectId: 'proj-1',
    machineId: 'machine-1',
    port: 3000,
};

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('resolvePreviewAuthorizeConfig', () => {
    it('returns null when either env value is missing', () => {
        expect(resolvePreviewAuthorizeConfig({})).toBeNull();
        expect(resolvePreviewAuthorizeConfig({ PREVIEW_AUTHZ_ORIGIN: 'https://studio.internal' })).toBeNull();
        expect(resolvePreviewAuthorizeConfig({ WEB_UI_TRUSTED_PREVIEW_SECRET: 's' })).toBeNull();
    });

    it('reuses the existing trusted preview secret and a fixed origin', () => {
        expect(resolvePreviewAuthorizeConfig({
            PREVIEW_AUTHZ_ORIGIN: 'https://studio.internal/',
            WEB_UI_TRUSTED_PREVIEW_SECRET: 'shared-secret',
        })).toEqual({ origin: 'https://studio.internal', secret: 'shared-secret' });
    });

    it('refuses an origin that is not a plain http(s) origin', () => {
        // The callback target must never be derived from a request; a
        // malformed operator value fails closed instead of becoming an SSRF
        // primitive.
        expect(resolvePreviewAuthorizeConfig({
            PREVIEW_AUTHZ_ORIGIN: 'file:///etc/passwd',
            WEB_UI_TRUSTED_PREVIEW_SECRET: 's',
        })).toBeNull();
        expect(resolvePreviewAuthorizeConfig({
            PREVIEW_AUTHZ_ORIGIN: 'studio.internal',
            WEB_UI_TRUSTED_PREVIEW_SECRET: 's',
        })).toBeNull();
    });
});

describe('createPreviewAuthorizer', () => {
    it('posts to the fixed origin with the shared secret header', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });

        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({ kind: 'allowed', workspacePaths: [] });

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(`https://studio.internal${PREVIEW_AUTHORIZE_PATH}`);
        expect((init.headers as Record<string, string>)['X-Trusted-Preview-Secret']).toBe('shared-secret');
        expect(JSON.parse(init.body as string)).toEqual(REQUEST);
    });

    it('never lets request-supplied values steer the callback URL', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });

        await authorizer.authorize({
            ...REQUEST,
            projectId: 'https://attacker.example/steal',
            machineId: '../../internal',
        });

        expect(fetchImpl.mock.calls[0][0]).toBe(`https://studio.internal${PREVIEW_AUTHORIZE_PATH}`);
    });

    it('denies when the studio says the user cannot access the project', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { allowed: false }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({ kind: 'denied' });
    });

    it('reports transport and malformed answers as unavailable, not as allowed', async () => {
        const failing = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        });
        await expect(failing.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });

        const garbage = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })),
        });
        await expect(garbage.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });

        const serverError = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })),
        });
        await expect(serverError.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it('treats every non-200 status as unavailable, never as a denial', async () => {
        // Only the contract answer — 200 with `{allowed:false}` — is a
        // decision. A 401/403 here means our own shared secret or path is
        // wrong, and a 404 means the endpoint moved: reading either as "the
        // user may not have this" would turn our misconfiguration into a
        // permanent, silent denial for everyone.
        for (const status of [301, 302, 400, 401, 403, 404, 500, 502]) {
            const authorizer = createPreviewAuthorizer({
                config: CONFIG,
                fetchImpl: vi.fn().mockResolvedValue(jsonResponse(status, { error: 'nope' })),
            });
            await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });
        }
    });

    it('refuses to follow a redirect rather than re-sending the secret elsewhere', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });
        await authorizer.authorize(REQUEST);
        expect(fetchImpl).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ redirect: 'error' }),
        );
    });

    it('ends within the deadline when the body never finishes arriving', async () => {
        // Headers arrive, body stalls. Aborting only the connect phase would
        // leave every preview request hanging on a half-open callback.
        const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"allowed":'));
                    init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
                },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl, timeoutMs: 30 });

        const started = Date.now();
        await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('refuses an answer larger than the response limit instead of buffering it', async () => {
        const huge = JSON.stringify({ allowed: true, workspacePaths: ['/srv/' + 'a'.repeat(200_000)] });
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, JSON.parse(huge))),
            maxResponseBytes: 4_096,
        });
        await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it('rejects an answer whose workspace list is not entirely strings', async () => {
        // Filtering the bad entries out would quietly narrow the project's
        // verified directories and turn a broken studio into an ownership
        // refusal nobody can explain.
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true, workspacePaths: ['/srv/a', 42] })),
        });
        await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it('rejects an answer whose workspace paths are not absolute', async () => {
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true, workspacePaths: ['relative/path'] })),
        });
        await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it('never puts the shared secret in the reason it reports', async () => {
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockRejectedValue(new Error(`connect failed for secret ${CONFIG.secret}`)),
        });
        const result = await authorizer.authorize(REQUEST);
        expect(JSON.stringify(result)).not.toContain(CONFIG.secret);
    });

    it('asks the studio again for every request, never from a cache', async () => {
        // A cached decision is a revocation window: the studio can remove the
        // user from the project, and a cache would keep serving them until it
        // expired. Access is re-checked per request, on purpose.
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });

        await authorizer.authorize(REQUEST);
        await authorizer.authorize(REQUEST);
        await authorizer.authorize(REQUEST);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('stops allowing the moment the studio revokes access', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse(200, { allowed: true }))
            .mockResolvedValue(jsonResponse(200, { allowed: false }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });

        await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'allowed' });
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({ kind: 'denied' });
    });

    it('re-asks after a denial rather than pinning it', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse(200, { allowed: false }))
            .mockResolvedValue(jsonResponse(200, { allowed: true }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });

        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({ kind: 'denied' });
        await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'allowed' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('recovers on the next request after the studio was unreachable', async () => {
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new Error('down'))
            .mockResolvedValue(jsonResponse(200, { allowed: true }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });

        await expect(authorizer.authorize(REQUEST)).resolves.toMatchObject({ kind: 'unavailable' });
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({ kind: 'allowed', workspacePaths: [] });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('createPreviewAuthorizer — workspace paths', () => {
    it('carries the studio-verified workspace paths through with the allow', async () => {
        // The daemon proves a plain dev-server process belongs to the project
        // by its cwd, and these are the only paths it is allowed to compare
        // against — they come from the studio, never from the caller.
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(
                jsonResponse(200, { allowed: true, workspacePaths: ['/srv/projects/a', '/srv/worktrees/a-1'] }),
            ),
        });
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({
            kind: 'allowed',
            workspacePaths: ['/srv/projects/a', '/srv/worktrees/a-1'],
        });
    });

    it('accepts an answer with no workspace list as an empty one', async () => {
        // A container-published runtime proves ownership by its project
        // label, so an allow with no paths is a legitimate answer.
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true })),
        });
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({ kind: 'allowed', workspacePaths: [] });
    });

    it('picks up workspace paths the studio changed between requests', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse(200, { allowed: true, workspacePaths: ['/srv/a'] }))
            .mockResolvedValue(jsonResponse(200, { allowed: true, workspacePaths: ['/srv/a', '/srv/a-2'] }));
        const authorizer = createPreviewAuthorizer({ config: CONFIG, fetchImpl });
        await authorizer.authorize(REQUEST);
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({
            kind: 'allowed',
            workspacePaths: ['/srv/a', '/srv/a-2'],
        });
    });
});
