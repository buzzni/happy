/**
 * Integration spec for the preview relay route's credential handling.
 *
 * The bug fix was an integration-level defect that unit tests (pure function
 * tests of header builders) could not catch: `outHeaders['Set-Cookie'] = …`
 * clobbered the upstream's `set-cookie` only because Node's `writeHead`
 * lower-cases all header keys before merging. So a preview upstream response
 * that set cookies got silently overwritten by the relay's own preview cookie.
 *
 * This spec drives the actual route end-to-end via app.inject to catch the
 * integration failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { previewRoutes } from './previewRoutes';
import { signPreviewToken } from '@/modules/preview/previewToken';
import { cookieName } from '@/modules/preview/previewCookie';
import { type Fastify as FastifyType } from '../types';

// Mock the daemon connection lookup, logging, and db
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        getConnections: vi.fn(),
    },
}));

vi.mock('@/storage/db', () => ({
    db: {},
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
}));

import { eventRouter } from '@/app/events/eventRouter';

const MID = '12345678-1234-1234-1234-123456789abc';
const PORT = 3000;
const SECRET = 'test-secret-key-for-ptoken';
const USER_ID = 'test-user-123';

// Both signPreviewToken (here) and verifyPreviewToken (inside the route) read
// this env var. Keep it as the single source — passing an explicit `{ secret }`
// to the signer only would drift from what the route verifies with.
process.env.HANDY_MASTER_SECRET = SECRET;

async function buildApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as FastifyType;

    // Stub the authenticate decorator so /v1/preview-token works without auth
    typed.decorate('authenticate', async (request: any, reply: any) => {
        request.userId = USER_ID;
    });

    previewRoutes(typed);
    await typed.ready();
    return typed;
}

function createFakeMachineSocket(capturedPayload: { current: any | null }) {
    return {
        id: 'socket-123',
        connected: true,
        timeout: vi.fn().mockReturnValue({
            emitWithAck: vi.fn().mockImplementation(async (event, payload) => {
                capturedPayload.current = payload;
                // Default response: success with no upstream cookies
                return {
                    type: 'success',
                    status: 200,
                    headers: {
                        'content-type': 'text/html; charset=utf-8',
                    },
                    bodyB64: Buffer.from('<html>OK</html>', 'utf-8').toString('base64'),
                    truncated: false,
                };
            }),
        }),
    };
}

describe('preview relay route credentials integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('forwards the app\'s Authorization header to the dev server', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: createFakeMachineSocket(capturedPayload) as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                authorization: 'Bearer app-token',
            },
        });

        expect(res.statusCode).toBe(200);
        expect(capturedPayload.current).not.toBeNull();
        expect(capturedPayload.current!.headers.authorization).toBe('Bearer app-token');
        await app.close();
    });

    it('forwards the app\'s cookies but not the relay\'s ptoken cookie', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: createFakeMachineSocket(capturedPayload) as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });
        const ptokenCookie = `${cookieName(MID, PORT)}=${signed.token}`;

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                cookie: `${ptokenCookie}; happy_preview_othermachine_9999=leak-me; sid=abc; theme=dark`,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(capturedPayload.current).not.toBeNull();
        // Should have app cookies but neither the ptoken nor the leak-me cookie
        expect(capturedPayload.current!.headers.cookie).toBe('sid=abc; theme=dark');
        await app.close();
    });

    it('omits the Cookie header entirely when only relay cookies were present', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: createFakeMachineSocket(capturedPayload) as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                cookie: `happy_preview_${MID}_${PORT}=${signed.token}; happy_preview_othermachine_9999=leak`,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(capturedPayload.current).not.toBeNull();
        // Cookie header should not be present
        expect(capturedPayload.current!.headers.cookie).toBeUndefined();
        await app.close();
    });

    it('authenticates via the relay cookie alone (no ?ptoken= in the URL) and still forwards app cookies', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: createFakeMachineSocket(capturedPayload) as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });
        const ptokenCookie = `${cookieName(MID, PORT)}=${signed.token}`;

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/data`,
            headers: {
                cookie: `${ptokenCookie}; sid=xyz; user=alice`,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(capturedPayload.current).not.toBeNull();
        // Should have app cookies from the relay cookie auth path
        expect(capturedPayload.current!.headers.cookie).toBe('sid=xyz; user=alice');
        await app.close();
    });

    it('preserves the app\'s Set-Cookie alongside the relay cookie (array form)', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const fakeMachineSocket = {
            id: 'socket-123',
            connected: true,
            timeout: vi.fn().mockReturnValue({
                emitWithAck: vi.fn().mockImplementation(async (event, payload) => {
                    capturedPayload.current = payload;
                    return {
                        type: 'success',
                        status: 200,
                        headers: {
                            'content-type': 'text/html; charset=utf-8',
                            // Array form (what current daemons send)
                            'set-cookie': [
                                'sid=abc; Path=/; HttpOnly',
                                'refresh=xyz; Path=/; HttpOnly',
                            ],
                        },
                        bodyB64: Buffer.from('<html>login</html>', 'utf-8').toString('base64'),
                        truncated: false,
                    };
                }),
            }),
        };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: fakeMachineSocket as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });

        const res = await app.inject({
            method: 'POST',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ username: 'user', password: 'pass' }),
        });

        expect(res.statusCode).toBe(200);
        // Response should have BOTH upstream cookies AND the relay ptoken cookie
        const setCookieHeader = res.headers['set-cookie'];
        expect(Array.isArray(setCookieHeader)).toBe(true);
        if (Array.isArray(setCookieHeader)) {
            // Should contain both app cookies
            expect(setCookieHeader.some((c) => c.includes('sid=abc'))).toBe(true);
            expect(setCookieHeader.some((c) => c.includes('refresh=xyz'))).toBe(true);
            // And the relay ptoken cookie
            expect(setCookieHeader.some((c) => c.includes(`${cookieName(MID, PORT)}=`))).toBe(true);
        }
        await app.close();
    });

    it('rewrites the app\'s cookie Path under the relay prefix in path-prefix mode', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const fakeMachineSocket = {
            id: 'socket-123',
            connected: true,
            timeout: vi.fn().mockReturnValue({
                emitWithAck: vi.fn().mockImplementation(async (event, payload) => {
                    capturedPayload.current = payload;
                    return {
                        type: 'success',
                        status: 200,
                        headers: {
                            'content-type': 'text/html',
                            'set-cookie': ['sid=abc; Path=/; HttpOnly'],
                        },
                        bodyB64: Buffer.from('<html>OK</html>', 'utf-8').toString('base64'),
                        truncated: false,
                    };
                }),
            }),
        };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: fakeMachineSocket as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                host: 'studio.example.com', // path-prefix mode
            },
        });

        expect(res.statusCode).toBe(200);
        const setCookieHeader = res.headers['set-cookie'];
        expect(Array.isArray(setCookieHeader)).toBe(true);
        if (Array.isArray(setCookieHeader)) {
            const appCookie = setCookieHeader.find((c) => c.includes('sid=abc'));
            expect(appCookie).toBeDefined();
            expect(appCookie).toContain(`Path=/v1/preview/${MID}/${PORT}/`);
        }
        await app.close();
    });

    it('leaves the cookie Path alone in subdomain mode', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const fakeMachineSocket = {
            id: 'socket-123',
            connected: true,
            timeout: vi.fn().mockReturnValue({
                emitWithAck: vi.fn().mockImplementation(async (event, payload) => {
                    capturedPayload.current = payload;
                    return {
                        type: 'success',
                        status: 200,
                        headers: {
                            'content-type': 'text/html',
                            'set-cookie': ['sid=abc; Path=/; HttpOnly'],
                        },
                        bodyB64: Buffer.from('<html>OK</html>', 'utf-8').toString('base64'),
                        truncated: false,
                    };
                }),
            }),
        };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: fakeMachineSocket as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                host: `${MID}-${PORT}.preview.saycode.ai`, // subdomain mode
            },
        });

        expect(res.statusCode).toBe(200);
        const setCookieHeader = res.headers['set-cookie'];
        expect(Array.isArray(setCookieHeader)).toBe(true);
        if (Array.isArray(setCookieHeader)) {
            const appCookie = setCookieHeader.find((c) => c.includes('sid=abc'));
            expect(appCookie).toBeDefined();
            // Path should stay as / in subdomain mode
            expect(appCookie).toContain('Path=/');
            expect(appCookie).not.toContain(`Path=/v1/preview`);
        }
        await app.close();
    });

    it('still forwards a POST body while forwarding credentials', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: createFakeMachineSocket(capturedPayload) as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });
        const testBody = { username: 'alice', password: 'secret123' };

        const res = await app.inject({
            method: 'POST',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                'content-type': 'application/json',
                authorization: 'Bearer app-token',
            },
            payload: JSON.stringify(testBody),
        });

        expect(res.statusCode).toBe(200);
        expect(capturedPayload.current).not.toBeNull();
        // Body should arrive base64-encoded
        expect(capturedPayload.current!.bodyB64).toBeDefined();
        const decodedBody = Buffer.from(capturedPayload.current!.bodyB64, 'base64').toString('utf-8');
        expect(JSON.parse(decodedBody)).toEqual(testBody);
        // Headers should still be forwarded
        expect(capturedPayload.current!.headers.authorization).toBe('Bearer app-token');
        await app.close();
    });

    it('handles legacy daemon comma-joined Set-Cookie with Expires date intact', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const fakeMachineSocket = {
            id: 'socket-123',
            connected: true,
            timeout: vi.fn().mockReturnValue({
                emitWithAck: vi.fn().mockImplementation(async (event, payload) => {
                    capturedPayload.current = payload;
                    return {
                        type: 'success',
                        status: 200,
                        headers: {
                            'content-type': 'text/html',
                            // Legacy form: comma-joined string with Expires date
                            'set-cookie': 'sid=abc; Path=/; Expires=Wed, 21 Oct 2025 07:28:00 GMT, refresh=xyz; Path=/',
                        },
                        bodyB64: Buffer.from('<html>OK</html>', 'utf-8').toString('base64'),
                        truncated: false,
                    };
                }),
            }),
        };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: fakeMachineSocket as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                host: 'studio.example.com',
            },
        });

        expect(res.statusCode).toBe(200);
        const setCookieHeader = res.headers['set-cookie'];
        expect(Array.isArray(setCookieHeader)).toBe(true);
        if (Array.isArray(setCookieHeader)) {
            // Should be split into exactly 2 app cookies + 1 relay cookie
            expect(setCookieHeader.length).toBeGreaterThanOrEqual(2);
            // Check that Expires date is intact (not split at its internal comma)
            const sidCookie = setCookieHeader.find((c) => c.includes('sid=abc'));
            expect(sidCookie).toBeDefined();
            expect(sidCookie).toContain('Expires=Wed, 21 Oct 2025 07:28:00 GMT');
            // Second cookie should be present
            const refreshCookie = setCookieHeader.find((c) => c.includes('refresh=xyz'));
            expect(refreshCookie).toBeDefined();
        }
        await app.close();
    });

    it('adds Secure and SameSite=None to upstream cookies when x-forwarded-proto is https', async () => {
        const app = await buildApp();
        const capturedPayload = { current: null as any };

        const fakeMachineSocket = {
            id: 'socket-123',
            connected: true,
            timeout: vi.fn().mockReturnValue({
                emitWithAck: vi.fn().mockImplementation(async (event, payload) => {
                    capturedPayload.current = payload;
                    return {
                        type: 'success',
                        status: 200,
                        headers: {
                            'content-type': 'text/html',
                            'set-cookie': ['sid=abc; Path=/; HttpOnly'],
                        },
                        bodyB64: Buffer.from('<html>OK</html>', 'utf-8').toString('base64'),
                        truncated: false,
                    };
                }),
            }),
        };

        const connections = new Set([
            { connectionType: 'machine-scoped', machineId: MID, socket: fakeMachineSocket as any },
        ]);
        vi.mocked(eventRouter.getConnections).mockReturnValue(connections as any);

        const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/api/login?ptoken=${signed.token}`,
            headers: {
                'x-forwarded-proto': 'https',
                host: `${MID}-${PORT}.preview.saycode.ai`, // subdomain mode for SameSite=None
            },
        });

        expect(res.statusCode).toBe(200);
        const setCookieHeader = res.headers['set-cookie'];
        expect(Array.isArray(setCookieHeader)).toBe(true);
        if (Array.isArray(setCookieHeader)) {
            // App cookie should have SameSite=None and Secure
            const appCookie = setCookieHeader.find((c) => c.includes('sid=abc'));
            expect(appCookie).toBeDefined();
            expect(appCookie).toContain('SameSite=None');
            expect(appCookie).toContain('Secure');
        }
        await app.close();
    });
});
