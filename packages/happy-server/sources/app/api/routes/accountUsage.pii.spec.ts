import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ session: vi.fn(), reports: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: {
    session: { findFirst: storage.session }, usageReport: { findMany: storage.reports },
} }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: {}, buildUpdateAccountUpdate: vi.fn() }));
vi.mock('@/storage/files', () => ({ getPublicUrl: vi.fn() }));
vi.mock('@/app/account/accountUpdateProfile', () => ({ accountUpdateProfile: vi.fn() }));
import { accountRoutes } from './accountRoutes';

beforeEach(() => {
    vi.clearAllMocks();
    storage.session.mockImplementation(async ({ where }) =>
        where.piiProtection === false ? null : { id: 'protected' });
    storage.reports.mockResolvedValue([]);
});

async function query(body: object, declared = false) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: any) => { request.userId = 'owner'; });
    accountRoutes(app as any);
    try {
        return await app.inject({
            method: 'POST', url: '/v1/usage/query', payload: body,
            headers: declared ? { 'x-happy-pii-protection': '1' } : {},
        });
    } finally { await app.close(); }
}

describe('usage query PII receive boundary', () => {
    it('hides a protected session before querying its usage', async () => {
        const response = await query({ sessionId: 'protected' });
        expect(response.statusCode).toBe(404);
        expect(storage.reports).not.toHaveBeenCalled();
    });
    it('filters protected sessions before account-wide aggregation, retaining sessionless usage', async () => {
        expect((await query({})).statusCode).toBe(200);
        expect(storage.reports).toHaveBeenCalledWith({
            where: { accountId: 'owner', OR: [
                { sessionId: null }, { session: { is: { piiProtection: false } } },
            ] },
            orderBy: { createdAt: 'desc' },
        });
    });
    it('keeps owner scope for a compatible reader', async () => {
        expect((await query({ sessionId: 'protected' }, true)).statusCode).toBe(200);
        expect(storage.session).toHaveBeenCalledWith({
            where: { id: 'protected', accountId: 'owner' },
        });
        expect(storage.reports).toHaveBeenCalledWith({
            where: { accountId: 'owner', sessionId: 'protected' },
            orderBy: { createdAt: 'desc' },
        });
    });
});
