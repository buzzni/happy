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
    automation: { findMany: vi.fn(), findUnique: vi.fn() },
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

    it('serves bounded cursor pages and rejects invalid input before reading protected rows', async () => {
        const response = await app.inject({ method: 'POST', url: '/v1/automations/page', payload: { projectIds: ['chat:c'], limit: 20 } });
        expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ automations: [], nextCursor: null });
        expect(db.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 21 }));
        db.automation.findMany.mockClear();
        for (const body of [{ projectIds: ['chat:c'], limit: 51 }, { projectIds: ['chat:c'], cursor: 'broken' }]) {
            expect((await app.inject({ method: 'POST', url: '/v1/automations/page', payload: body })).statusCode).toBe(400);
        }
        expect(db.automation.findMany).not.toHaveBeenCalled();
    });

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

    it('reads an existing machine public key without creating a project or rotating a key', async () => {
        db.machine.findUnique.mockResolvedValue({ id: 'machine-1', accountId: 'reader', automationPublicKey: new Uint8Array(32).fill(7), automationKeyVersion: 3 });
        const response = await app.inject({ method: 'GET', url: '/v1/machines/machine-1/automation-reader-key' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ machineId: 'machine-1', machineAccountId: 'reader', publicKey: Buffer.alloc(32, 7).toString('base64'), keyVersion: 3 });
        expect(db.machine.findUnique).toHaveBeenCalledWith({ where: { accountId_id: { accountId: 'reader', id: 'machine-1' } }, select: { id: true, automationPublicKey: true, automationKeyVersion: true } });
        expect(db.project.findUnique).not.toHaveBeenCalled();
        db.machine.findUnique.mockResolvedValue(null);
        expect((await app.inject({ method: 'GET', url: '/v1/machines/machine-1/automation-reader-key' })).statusCode).toBe(404);
    });

    it('returns a machine envelope only to its owner on the currently bound machine', async () => {
        const url = '/v1/projects/project-1/automations/reservation/management?machineId=machine-1';
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
        expect(db.automation.findUnique).not.toHaveBeenCalled();
        db.project.findUnique.mockResolvedValue({ id: 'project-1', accountId: 'reader', config: { machineId: 'machine-1' } });
        db.machine.findUnique.mockResolvedValue({ id: 'machine-1', accountId: 'reader', automationPublicKey: new Uint8Array(32), automationKeyVersion: 1, automationProtocolVersion: 1 });
        const now = new Date();
        const row = { id: 'reservation', projectId: 'project-1', ownerAccountId: 'reader', machineAccountId: 'reader', machineId: 'machine-1', payloadVersion: 4, deletedAt: null,
            payloadCiphertext: new Uint8Array([1]), viewerKeyEnvelope: new Uint8Array([2]), machineKeyEnvelope: new Uint8Array([3]), enabledAt: now, createdAt: now, updatedAt: now };
        db.automation.findUnique.mockResolvedValue(row);
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.json().automation.machineKeyEnvelope).toBe('Aw==');
        db.automation.findMany.mockResolvedValue([row]);
        expect((await app.inject({ method: 'GET', url: '/v1/projects/project-1/automations' })).json().automations[0]).not.toHaveProperty('machineKeyEnvelope');
        for (const change of [{ machineId: 'other' }, { ownerAccountId: 'other' }, { machineAccountId: 'other' }, { deletedAt: now }]) {
            db.automation.findUnique.mockResolvedValue({ ...row, ...change });
            const denied = await app.inject({ method: 'GET', url });
            expect(denied.statusCode).toBe(403);
            expect(denied.json()).not.toHaveProperty('automation');
        }
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
