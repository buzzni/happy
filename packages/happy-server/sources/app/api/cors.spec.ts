import { createServer } from 'node:http';
import fastify from 'fastify';
import { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';
import {
    fastifyCorsDelegate,
    isAllowedCorsOrigin,
    socketCorsOrigin,
} from '@/app/api/cors';

describe('isAllowedCorsOrigin', () => {
    it.each([
        'https://saycode.ai',
        'https://dev-studio.preview.saycode.ai',
        'http://localhost:3000',
        'http://127.0.0.1:5173',
        'https://12345678-1234-1234-1234-123456789abc-41009.preview.saycode.ai',
    ])('allows %s', (origin) => {
        expect(isAllowedCorsOrigin(origin)).toBe(true);
    });

    it.each([
        undefined,
        'null',
        'https://evil.example.com',
        'https://saycode.ai.attacker.example.com',
        'https://dev-studio.preview.saycode.ai.attacker.example.com',
        'https://12345678-1234-1234-1234-123456789abc-41009.preview.evil.example.com',
        'https://12345678-1234-1234-1234-123456789abc-41009.preview.evil.preview.saycode.ai',
        'https://localhost:3000',
        'http://localhost',
        'http://localhost:0',
        'http://127.0.0.1:65536',
        'file:///tmp/app.html',
    ])('rejects %s', (origin) => {
        expect(isAllowedCorsOrigin(origin)).toBe(false);
    });

    it('gives allowed origins credentialed CORS and rejected origins none', () => {
        const decided: unknown[] = [];
        const record = (_error: Error | null, options: { origin: string | boolean; credentials?: boolean }) =>
            decided.push([options.origin, options.credentials ?? false]);
        fastifyCorsDelegate({ headers: { origin: 'https://saycode.ai' } }, record);
        fastifyCorsDelegate({ headers: { origin: 'https://evil.example.com' } }, record);
        fastifyCorsDelegate({ headers: {} }, record);

        expect(decided).toEqual([['https://saycode.ai', true], [false, false], [false, false]]);
    });

    it('returns a boolean decision for Socket.IO', () => {
        const allowed: unknown[] = [];
        socketCorsOrigin('http://127.0.0.1:5173', (_error, value) => allowed.push(value));
        socketCorsOrigin('null', (_error, value) => allowed.push(value));

        expect(allowed).toEqual([true, false]);
    });

    it('restricts Fastify simple requests and preflight responses', async () => {
        const app = fastify();
        const cors = (await import('@fastify/cors')).default;
        await app.register(cors, () => fastifyCorsDelegate);
        app.get('/v1/sessions', async () => ({ ok: true }));
        await app.ready();

        const allowed = await app.inject({
            method: 'GET',
            url: '/v1/sessions',
            headers: { origin: 'https://saycode.ai' },
        });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.headers['access-control-allow-origin']).toBe('https://saycode.ai');
        expect(allowed.headers['access-control-allow-credentials']).toBe('true');

        const denied = await app.inject({
            method: 'OPTIONS',
            url: '/v1/sessions',
            headers: {
                origin: 'https://evil.example.com',
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'authorization',
            },
        });
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();

        const allowedPreflight = await app.inject({
            method: 'OPTIONS',
            url: '/v1/sessions',
            headers: {
                origin: 'https://saycode.ai',
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'authorization',
            },
        });
        expect(allowedPreflight.headers['access-control-allow-origin']).toBe('https://saycode.ai');
        expect(allowedPreflight.headers['access-control-allow-headers']).toBe('authorization');

        await app.close();
    });

    it('lets the packaged desktop renderer (Origin: null) call the API without credentials', async () => {
        // The packaged desktop renderer runs from file://, so its fetches carry `Origin: null`.
        // The API authenticates with Bearer tokens, so this origin gets CORS without credentials:
        // no ambient cookie can be read through it.
        const app = fastify();
        const cors = (await import('@fastify/cors')).default;
        await app.register(cors, () => fastifyCorsDelegate);
        app.get('/v1/account/settings', async () => ({ ok: true }));
        await app.ready();

        const preflight = await app.inject({
            method: 'OPTIONS',
            url: '/v1/account/settings',
            headers: {
                origin: 'null',
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'authorization',
            },
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe('null');
        expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
        expect(preflight.headers['access-control-allow-headers']).toBe('authorization');

        const simple = await app.inject({ method: 'GET', url: '/v1/account/settings', headers: { origin: 'null' } });
        expect(simple.headers['access-control-allow-origin']).toBe('null');
        expect(simple.headers['access-control-allow-credentials']).toBeUndefined();

        const studio = await app.inject({ method: 'GET', url: '/v1/account/settings', headers: { origin: 'https://saycode.ai' } });
        expect(studio.headers['access-control-allow-origin']).toBe('https://saycode.ai');
        expect(studio.headers['access-control-allow-credentials']).toBe('true');

        const evil = await app.inject({
            method: 'OPTIONS',
            url: '/v1/account/settings',
            headers: {
                origin: 'https://evil.example.com',
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'authorization',
            },
        });
        expect(evil.headers['access-control-allow-origin']).toBeUndefined();
        expect(evil.headers['access-control-allow-credentials']).toBeUndefined();

        await app.close();
    });

    it('restricts Socket.IO polling response headers', async () => {
        const httpServer = createServer();
        const io = new Server(httpServer, {
            path: '/v1/updates',
            transports: ['polling'],
            cors: {
                origin: socketCorsOrigin,
                methods: ['GET', 'POST', 'OPTIONS'],
                credentials: true,
            },
        });

        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        const address = httpServer.address();
        if (!address || typeof address === 'string') throw new Error('server did not bind');
        const url = `http://127.0.0.1:${address.port}/v1/updates/?EIO=4&transport=polling`;

        const allowed = await fetch(url, { headers: { Origin: 'http://127.0.0.1:5173' } });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
        expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

        const denied = await fetch(url, { headers: { Origin: 'https://evil.example.com' } });
        expect(denied.status).toBe(200);
        expect(denied.headers.get('access-control-allow-origin')).toBeNull();

        await new Promise<void>((resolve) => io.close(() => resolve()));
    });
});
