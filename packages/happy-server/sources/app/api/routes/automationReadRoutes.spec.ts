import fastify from 'fastify';
import { Prisma } from '@prisma/client';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const db = vi.hoisted(() => ({
    $transaction: vi.fn(),
    project: { findUnique: vi.fn() },
    projectMember: { findUnique: vi.fn() },
    machine: { findUnique: vi.fn() },
    automation: { findMany: vi.fn() },
    automationRun: { findMany: vi.fn() },
}));
vi.mock('@/storage/db', () => ({ db }));
vi.mock('@/app/automation/automationUpdate', () => ({
    emitAutomationUpdate: vi.fn(), emitProjectAutomationUpdate: vi.fn(),
}));
import { automationRoutes } from './automationRoutes';

const paths = ['automations', 'automation-runs', 'automation-target'];

describe('automation reads without interactive transaction expiry', () => {
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'reader'; });
    automationRoutes(app as unknown as Fastify);

    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv('SAYCODE_AUTOMATION_ENABLED', 'true');
        db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
            'Transaction already closed: expired transaction', { code: 'P2028', clientVersion: '6.19.2' },
        ));
        db.project.findUnique.mockResolvedValue({
            id: 'project-1', accountId: 'owner', config: { machineId: 'machine-1' },
            automationViewerPublicKey: new Uint8Array([3]), automationViewerKeyVersion: 1,
        });
        db.projectMember.findUnique.mockResolvedValue({ role: 'viewer', status: 'accepted' });
        db.machine.findUnique.mockResolvedValue({
            id: 'machine-1', accountId: 'owner', automationPublicKey: new Uint8Array([1, 2]),
            automationKeyVersion: 1, automationProtocolVersion: 1,
        });
        db.automation.findMany.mockResolvedValue([]);
        db.automationRun.findMany.mockResolvedValue([]);
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(paths)('serves %s for accepted viewers when interactive transactions expire', async (path) => {
        const response = await app.inject({ method: 'GET', url: `/v1/projects/project-1/${path}` });
        expect(response.statusCode).toBe(200);
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(db.projectMember.findUnique).toHaveBeenCalledWith({
            where: { projectId_accountId: { projectId: 'project-1', accountId: 'reader' } },
            select: { role: true, status: true },
        });
        if (path === 'automation-target') {
            expect(response.json().target).toMatchObject({ machinePublicKey: 'AQI=', viewerPublicKey: 'Aw==' });
        } else {
            expect(response.json()).toEqual(path === 'automations' ? { automations: [] } : { runs: [] });
        }
    });

    it.each(paths)('denies %s to unaccepted members before reading protected data', async (path) => {
        db.projectMember.findUnique.mockResolvedValue({ role: 'viewer', status: 'pending' });
        const response = await app.inject({ method: 'GET', url: `/v1/projects/project-1/${path}` });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'not-found' });
        expect(db.automation.findMany).not.toHaveBeenCalled();
        expect(db.automationRun.findMany).not.toHaveBeenCalled();
        expect(db.machine.findUnique).not.toHaveBeenCalled();
    });

    it('keeps run filtering, ordering and the validated limit', async () => {
        const response = await app.inject({
            method: 'GET', url: '/v1/projects/project-1/automation-runs?automationId=automation-1&limit=100',
        });
        expect(response.statusCode).toBe(200);
        expect(db.automationRun.findMany).toHaveBeenCalledWith({
            where: { automation: { projectId: 'project-1' }, automationId: 'automation-1' },
            orderBy: [{ claimedAt: 'desc' }, { scheduledFor: 'desc' }], take: 100,
        });
    });

    it('retains interactive transactions for writes', async () => {
        const response = await app.inject({
            method: 'PUT', url: '/v1/projects/project-1/automation-viewer-key',
            payload: { expectedKeyVersion: 1, publicKey: Buffer.alloc(32, 7).toString('base64') },
        });
        expect(response.statusCode).toBe(500);
        expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'Serializable', timeout: 10000,
        });
    });
});
