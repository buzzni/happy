import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { gzipSync } from 'node:zlib';
import { fastifyCorsDelegate } from '@/app/api/cors';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { previewRoutes } from './previewRoutes';
import { signPreviewToken } from '@/modules/preview/previewToken';
import type { Fastify as TypedFastify } from '../types';

const fixture = vi.hoisted(() => ({ fetchSockets: vi.fn(), emit: vi.fn() }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { server: { in: () => ({ timeout: () => ({ fetchSockets: fixture.fetchSockets }) }) } } }));
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

const mid = '11111111-1111-4111-8111-111111111111';
const prefix = `/v1/preview/${mid}/3000`;
const marker = 'x-happy-preview-transport';
const html = '<html><head></head><body><a href="/settings?tab=1#account">Settings</a></body></html>';
let app: TypedFastify;

beforeEach(async () => {
    vi.stubEnv('HANDY_MASTER_SECRET', 'localhost-transport-fixture-secret');
    vi.stubEnv('PREVIEW_RUNTIME_BINDING_POLICY', 'off');
    fixture.emit.mockReset().mockResolvedValue({ type: 'success', status: 200, headers: { 'content-type': 'text/html' }, bodyB64: Buffer.from(html).toString('base64'), truncated: false });
    fixture.fetchSockets.mockReset().mockResolvedValue([{ id: 'fixture', data: { clientType: 'machine-scoped', machineId: mid }, timeout: () => ({ emitWithAck: fixture.emit }) }]);
    const server = Fastify();
    await server.register(cors, () => fastifyCorsDelegate);
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    app = server.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    app.decorate('authenticate', async (request: { userId?: string }) => { request.userId = 'fixture-user'; });
    previewRoutes(app);
    await app.ready();
});
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

function url(path = '/') {
    const signed = signPreviewToken({ userId: 'fixture-user', machineId: mid, port: 3000 });
    return `${prefix}${path}${path.includes('?') ? '&' : '?'}ptoken=${signed.token}`;
}

describe('authenticated localhost forwarding', () => {
    it('preserves the HTML body while normal web preview still rewrites it', async () => {
        const forwarded = await app.inject({ method: 'GET', url: url(), headers: { [marker]: 'localhost-v1' } });
        expect(forwarded.statusCode).toBe(200);
        expect(forwarded.body).toBe(html);
        expect(forwarded.headers[marker]).toBe('localhost-v1');
        expect(forwarded.headers['set-cookie']).toBeUndefined();
        expect(fixture.emit.mock.calls[0][1].headers[marker]).toBeUndefined();
        const web = await app.inject({ method: 'GET', url: url() });
        expect(web.body).toContain(`href="${prefix}/settings`);
        expect(web.headers[marker]).toBeUndefined();
    });

    it('preserves redirect, cookie, CSP, and preload headers', async () => {
        fixture.emit.mockResolvedValue({ type: 'success', status: 302, headers: { location: '/oauth/callback?code=fixture&state=a%2Bb', 'set-cookie': ['session=fixture; Path=/oauth; HttpOnly'], 'content-security-policy': "default-src 'self'", 'x-frame-options': 'DENY', link: '</style.css>; rel=preload' }, bodyB64: '', truncated: false });
        const response = await app.inject({ method: 'GET', url: url('/oauth/start'), headers: { [marker]: 'localhost-v1' } });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/oauth/callback?code=fixture&state=a%2Bb');
        expect(response.headers['set-cookie']).toEqual(['session=fixture; Path=/oauth; HttpOnly']);
        expect(response.headers['content-security-policy']).toBe("default-src 'self'");
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers.link).toBe('</style.css>; rel=preload');
    });

    it('preserves an encoded application response without changing its bytes', async () => {
        const body = gzipSync(html);
        fixture.emit.mockResolvedValue({ type: 'success', status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, bodyB64: body.toString('base64'), truncated: false });
        const response = await app.inject({ method: 'GET', url: url(), headers: { [marker]: 'localhost-v1' } });
        expect(response.headers['content-encoding']).toBe('gzip');
        expect(response.rawPayload).toEqual(body);
    });

    it.each([undefined, 'invalid'])('does not bypass authentication with token %s', async token => {
        const response = await app.inject({ method: 'GET', url: `${prefix}/${token ? `?ptoken=${token}` : ''}`, headers: { [marker]: 'localhost-v1' } });
        expect(response.statusCode).toBe(401);
        expect(fixture.emit).not.toHaveBeenCalled();
    });

    it('does not bypass the machine/port token scope', async () => {
        const response = await app.inject({ method: 'GET', url: url().replace('/3000/', '/3001/'), headers: { [marker]: 'localhost-v1' } });
        expect(response.statusCode).toBe(403);
        expect(fixture.emit).not.toHaveBeenCalled();
    });

    it('does not bypass required runtime binding', async () => {
        vi.stubEnv('PREVIEW_RUNTIME_BINDING_POLICY', 'required');
        vi.stubEnv('PREVIEW_BINDING_LEGACY_MACHINE_IDS', '');
        const response = await app.inject({ method: 'GET', url: url(), headers: { [marker]: 'localhost-v1' } });
        expect(response.statusCode).toBe(401);
        expect(fixture.emit).not.toHaveBeenCalled();
    });

    it('lets the application answer a localhost CORS preflight', async () => {
        fixture.emit.mockResolvedValue({ type: 'success', status: 204, headers: { 'access-control-allow-origin': 'http://localhost:3000', 'access-control-allow-methods': 'POST' }, bodyB64: '', truncated: false });
        const response = await app.inject({ method: 'OPTIONS', url: url('/api/save'), headers: { [marker]: 'localhost-v1', origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
        expect(response.statusCode).toBe(204);
        expect(response.headers[marker]).toBe('localhost-v1');
        expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
        expect(fixture.emit).toHaveBeenCalledOnce();
        const web = await app.inject({ method: 'OPTIONS', url: url('/api/save'), headers: { origin: 'https://studio.example', 'access-control-request-method': 'POST' } });
        expect(web.statusCode).toBe(204);
        expect(fixture.emit).toHaveBeenCalledOnce();
    });
});
