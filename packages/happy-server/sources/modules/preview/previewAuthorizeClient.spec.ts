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

    it('treats a 401/403 from the studio as a denial', async () => {
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse(403, { error: 'nope' })),
        });
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({ kind: 'denied' });
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
            .mockResolvedValueOnce(jsonResponse(403, { error: 'nope' }))
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

    it('ignores non-string entries rather than passing them to the daemon', async () => {
        const authorizer = createPreviewAuthorizer({
            config: CONFIG,
            fetchImpl: vi.fn().mockResolvedValue(
                jsonResponse(200, { allowed: true, workspacePaths: ['/srv/a', 42, null] }),
            ),
        });
        await expect(authorizer.authorize(REQUEST)).resolves.toEqual({
            kind: 'allowed',
            workspacePaths: ['/srv/a'],
        });
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
