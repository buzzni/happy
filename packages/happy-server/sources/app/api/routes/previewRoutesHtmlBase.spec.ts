/**
 * Integration spec: the relay pins an HTML document's <base href> at the
 * directory of the requested file, not the prefix root.
 *
 * An embedded editor (CrossEditor) loads its inner iframe page from
 * /crosseditor/config/htmls/crosseditor.html, which pulls in
 * `../../lib/jquery.min.js`. With the base pinned at the prefix root those
 * requests went to /lib/… and the editor rendered as an empty box.
 */

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { previewRoutes } from './previewRoutes';
import { signPreviewToken } from '@/modules/preview/previewToken';
import { type Fastify as FastifyType } from '../types';

// Same Socket.IO room shim as previewRoutesCredentials.spec.ts.
vi.mock('@/app/events/eventRouter', () => {
    const getConnections = vi.fn();
    return {
        eventRouter: {
            getConnections,
            server: {
                in(room: string) {
                    return {
                        timeout() {
                            return {
                                async fetchSockets() {
                                    const machineId = room.split(':machine:')[1];
                                    const connections = (getConnections() ?? []) as Iterable<any>;
                                    return [...connections]
                                        .filter((c) => c.connectionType === 'machine-scoped' && c.machineId === machineId)
                                        .map((c) => ({ ...c.socket, data: { clientType: 'machine-scoped', machineId: c.machineId } }));
                                },
                            };
                        },
                    };
                },
            },
        },
    };
});

vi.mock('@/storage/db', () => ({
    db: { workMachineExecution: { findFirst: async () => null } },
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
}));

import { eventRouter } from '@/app/events/eventRouter';

const MID = '12345678-1234-1234-1234-123456789abc';
const PORT = 3000;
const USER_ID = 'test-user-123';

process.env.HANDY_MASTER_SECRET = 'test-secret-key-for-ptoken';

async function buildApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as FastifyType;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = USER_ID;
    });
    previewRoutes(typed);
    await typed.ready();
    return typed;
}

function serveHtml() {
    const socket = {
        id: 'socket-123',
        connected: true,
        timeout: vi.fn().mockReturnValue({
            emitWithAck: vi.fn().mockResolvedValue({
                type: 'success',
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                bodyB64: Buffer.from('<html><head></head><body></body></html>', 'utf-8').toString('base64'),
                truncated: false,
            }),
        }),
    };
    vi.mocked(eventRouter.getConnections).mockReturnValue(new Set([
        { connectionType: 'machine-scoped', machineId: MID, socket },
    ]) as any);
}

async function fetchDocument(subPath: string, host: string) {
    serveHtml();
    const app = await buildApp();
    const signed = signPreviewToken({ userId: USER_ID, machineId: MID, port: PORT });
    try {
        const res = await app.inject({
            method: 'GET',
            url: `/v1/preview/${MID}/${PORT}/${subPath}?ptoken=${signed.token}`,
            headers: { host },
        });
        expect(res.statusCode).toBe(200);
        return res.body;
    } finally {
        await app.close();
    }
}

describe('preview relay <base href> for nested HTML documents', () => {
    it('pins the base at the requested .html file directory in path-prefix mode', async () => {
        const body = await fetchDocument('crosseditor/config/htmls/crosseditor.html', 'studio.example.com');
        expect(body).toContain(`<base href="/v1/preview/${MID}/${PORT}/crosseditor/config/htmls/">`);
    });

    it('pins the base at the requested .html file directory in subdomain mode', async () => {
        const body = await fetchDocument('crosseditor/config/htmls/crosseditor.html', `${MID}-${PORT}.preview.saycode.ai`);
        expect(body).toContain('<base href="/crosseditor/config/htmls/">');
    });

    it('keeps the base at the prefix root for SPA routes', async () => {
        const body = await fetchDocument('notices/new', 'studio.example.com');
        expect(body).toContain(`<base href="/v1/preview/${MID}/${PORT}/">`);
    });
});
