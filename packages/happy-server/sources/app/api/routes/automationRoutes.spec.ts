import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({
    createAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    getAutomationTarget: vi.fn(),
    listAutomationRuns: vi.fn(),
    listAutomations: vi.fn(),
    setAutomationViewerKey: vi.fn(),
    updateAutomation: vi.fn(),
    emitAutomationUpdate: vi.fn(),
}));

vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback({}) }));
vi.mock('@/app/automation/automationService', () => mocks);
vi.mock('@/app/automation/automationUpdate', () => ({ emitAutomationUpdate: mocks.emitAutomationUpdate }));

import { automationRoutes } from './automationRoutes';

function record() {
    return {
        id: 'automation-1',
        projectId: 'project-1',
        ownerAccountId: 'user-1',
        machineAccountId: 'machine-owner',
        machineId: 'machine-1',
        revision: 1,
        generation: 1,
        payloadVersion: 1,
        payloadCiphertext: new Uint8Array([1, 2, 3]),
        viewerKeyId: 'viewer-key',
        viewerKeyVersion: 1,
        viewerKeyEnvelope: new Uint8Array([4, 5]),
        machineKeyVersion: 1,
        machineKeyEnvelope: new Uint8Array([6, 7]),
        paused: false,
        enabledAt: new Date(10),
        deletedAt: null,
        appliedRevision: 0,
        appliedAt: null,
        legacyMachineId: null,
        legacyAutomationId: null,
        createdAt: new Date(20),
        updatedAt: new Date(30),
    };
}

async function makeApp() {
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'user-1'; });
    automationRoutes(app as unknown as Fastify);
    return app;
}

describe('automationRoutes', () => {
    const payloadCiphertext = new Uint8Array([1, ...new Uint8Array(40).fill(2)]);
    const keyEnvelope = new Uint8Array([1, ...new Uint8Array(104).fill(3)]);

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.HAPPY_SERVER_BACKED_AUTOMATION_ACCOUNTS = '*';
    });
    afterEach(() => delete process.env.HAPPY_SERVER_BACKED_AUTOMATION_ACCOUNTS);

    it('keeps the API unavailable unless the authenticated account is allowlisted', async () => {
        process.env.HAPPY_SERVER_BACKED_AUTOMATION_ACCOUNTS = 'user-2';
        const app = await makeApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/projects/project-1/automations',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'feature-disabled' });
        expect(mocks.listAutomations).not.toHaveBeenCalled();
    });

    it('decodes encrypted create fields and derives actor/project outside the body', async () => {
        mocks.createAutomation.mockResolvedValue({ ok: true, value: record() });
        const app = await makeApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/projects/project-1/automations',
            headers: { authorization: 'Bearer test' },
            payload: {
                payloadVersion: 1,
                payloadCiphertext: Buffer.from(payloadCiphertext).toString('base64'),
                viewerKeyId: 'viewer-key',
                viewerKeyVersion: 1,
                viewerKeyEnvelope: Buffer.from(keyEnvelope).toString('base64'),
                machineKeyVersion: 1,
                machineKeyEnvelope: Buffer.from(keyEnvelope).toString('base64'),
                paused: false,
            },
        });

        expect(response.statusCode).toBe(200);
        expect(mocks.createAutomation).toHaveBeenCalledWith({}, 'user-1', 'project-1', expect.objectContaining({
            payloadCiphertext,
            viewerKeyEnvelope: keyEnvelope,
            machineKeyEnvelope: keyEnvelope,
        }));
        expect(response.json().automation.payloadCiphertext).toBe('AQID');
        expect(mocks.emitAutomationUpdate).toHaveBeenCalledWith('user-1', {
            projectId: 'project-1', automationId: 'automation-1', revision: 1,
            generation: 1, reason: 'upsert',
        });
    });

    it('returns 409 with the latest public row for a CAS conflict', async () => {
        mocks.updateAutomation.mockResolvedValue({ ok: false, error: 'revision-conflict', latest: record() });
        const app = await makeApp();

        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/projects/project-1/automations/automation-1',
            headers: { authorization: 'Bearer test' },
            payload: { expectedRevision: 1, paused: true },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
            error: 'revision-conflict',
            latest: { id: 'automation-1', revision: 1 },
        });
    });

    it('rejects a no-op patch before calling the service', async () => {
        const app = await makeApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/projects/project-1/automations/automation-1',
            headers: { authorization: 'Bearer test' },
            payload: { expectedRevision: 1 },
        });

        expect(response.statusCode).toBe(400);
        expect(mocks.updateAutomation).not.toHaveBeenCalled();
    });
});
