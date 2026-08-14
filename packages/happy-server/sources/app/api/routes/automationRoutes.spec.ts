import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({
    activateAutomationAdoption: vi.fn(),
    adoptAutomation: vi.fn(),
    createAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    getAutomationTarget: vi.fn(),
    listAutomationRuns: vi.fn(),
    listAutomations: vi.fn(),
    replaceAutomationViewerKeyIfUnused: vi.fn(),
    resolveAutomationRunMcpContext: vi.fn(),
    setAutomationViewerKey: vi.fn(),
    updateAutomation: vi.fn(),
    emitAutomationUpdate: vi.fn(),
}));

vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback({}) }));
vi.mock('@/app/automation/automationService', () => mocks);
vi.mock('@/app/automation/automationExecutionService', () => ({
    resolveAutomationRunMcpContext: mocks.resolveAutomationRunMcpContext,
}));
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
        legacyMigrationPending: false,
        legacyDesiredPaused: null,
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
        process.env.SAYCODE_AUTOMATION_ENABLED = 'true';
    });
    afterEach(() => delete process.env.SAYCODE_AUTOMATION_ENABLED);

    it('keeps the API unavailable when the global rollout flag is disabled', async () => {
        process.env.SAYCODE_AUTOMATION_ENABLED = 'false';
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

    it('serializes a degraded connector code in automation run history', async () => {
        mocks.listAutomationRuns.mockResolvedValue({
            ok: true,
            value: [{
                id: 'run-1', automationId: 'automation-1', generation: 1,
                scheduledFor: new Date(1), machineId: 'machine-1', status: 'COMPLETED',
                sessionId: 'session-1', outcome: 'WOKE', detailCiphertext: null,
                failureCode: null, degradedCode: 'GRANT_MISSING', claimedAt: new Date(2),
                startedAt: new Date(3), completedAt: new Date(4), lateReport: false,
            }],
        });
        const app = await makeApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/projects/project-1/automation-runs',
            headers: { authorization: 'Bearer test' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().runs[0]).toMatchObject({ degradedCode: 'GRANT_MISSING' });
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

    it('exposes the guarded viewer-key replacement contract', async () => {
        mocks.replaceAutomationViewerKeyIfUnused.mockResolvedValue({ ok: true, value: { keyVersion: 3 } });
        const app = await makeApp();
        const publicKey = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

        const response = await app.inject({
            method: 'PUT',
            url: '/v1/projects/project-1/automation-viewer-key/replace-if-unused',
            headers: { authorization: 'Bearer test' },
            payload: { expectedKeyVersion: 2, publicKey },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ keyVersion: 3 });
        expect(mocks.replaceAutomationViewerKeyIfUnused).toHaveBeenCalledWith({}, 'user-1', 'project-1', {
            expectedKeyVersion: 2,
            publicKey: new Uint8Array(32).fill(7),
        });
    });

    it('returns a distinct conflict when DB automations still use the viewer key', async () => {
        mocks.replaceAutomationViewerKeyIfUnused.mockResolvedValue({ ok: false, error: 'viewer-key-in-use' });
        const app = await makeApp();

        const response = await app.inject({
            method: 'PUT',
            url: '/v1/projects/project-1/automation-viewer-key/replace-if-unused',
            headers: { authorization: 'Bearer test' },
            payload: {
                expectedKeyVersion: 2,
                publicKey: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'viewer-key-in-use' });
    });

    it('returns a running automation owner context only from the authenticated machine claim', async () => {
        mocks.resolveAutomationRunMcpContext.mockResolvedValue({
            ok: true,
            value: {
                automationId: 'automation-1',
                ownerAccountId: 'automation-owner',
                projectId: 'project-1',
                machineId: 'machine-1',
                runLeaseExpiresAt: 1_000_060_000,
            },
        });
        const app = await makeApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/automation-runs/run-1/mcp-context',
            headers: { authorization: 'Bearer test' },
            payload: { machineId: 'machine-1', claimToken: 'claim-token' },
        });

        expect(response.statusCode).toBe(200);
        expect(mocks.resolveAutomationRunMcpContext).toHaveBeenCalledWith({}, 'user-1', 'machine-1', {
            runId: 'run-1', claimToken: 'claim-token',
        });
        expect(response.json()).toEqual({
            automationId: 'automation-1',
            ownerAccountId: 'automation-owner',
            projectId: 'project-1',
            machineId: 'machine-1',
            runLeaseExpiresAt: 1_000_060_000,
        });
    });

    it('rejects an automation MCP context request without machine claim proof', async () => {
        const app = await makeApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/automation-runs/run-1/mcp-context',
            headers: { authorization: 'Bearer test' },
            payload: { machineId: 'machine-1' },
        });

        expect(response.statusCode).toBe(400);
        expect(mocks.resolveAutomationRunMcpContext).not.toHaveBeenCalled();
    });

    it('forwards a spawned session id for machine ownership verification', async () => {
        mocks.resolveAutomationRunMcpContext.mockResolvedValue({
            ok: true,
            value: {
                automationId: 'automation-1', ownerAccountId: 'automation-owner',
                projectId: 'project-1', machineId: 'machine-1', runLeaseExpiresAt: null,
            },
        });
        const app = await makeApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/automation-runs/run-1/mcp-context',
            headers: { authorization: 'Bearer test' },
            payload: { machineId: 'machine-1', claimToken: 'claim-token', sessionId: 'session-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(mocks.resolveAutomationRunMcpContext).toHaveBeenCalledWith({}, 'user-1', 'machine-1', {
            runId: 'run-1', claimToken: 'claim-token', sessionId: 'session-1',
        });
    });

    it('stages and activates an explicitly confirmed legacy adoption', async () => {
        const staged = {
            ...record(), paused: true, legacyMachineId: 'machine-1', legacyAutomationId: 'legacy-1',
            legacyMigrationPending: true, legacyDesiredPaused: false,
        };
        mocks.adoptAutomation.mockResolvedValue({ ok: true, value: staged });
        mocks.activateAutomationAdoption.mockResolvedValue({ ok: true, value: { ...staged, revision: 2, legacyMigrationPending: false } });
        const app = await makeApp();
        const encrypted = {
            payloadVersion: 1,
            payloadCiphertext: Buffer.from(payloadCiphertext).toString('base64'),
            viewerKeyId: 'viewer-key', viewerKeyVersion: 1,
            viewerKeyEnvelope: Buffer.from(keyEnvelope).toString('base64'),
            machineKeyVersion: 1, machineKeyEnvelope: Buffer.from(keyEnvelope).toString('base64'),
        };

        const adopted = await app.inject({
            method: 'POST', url: '/v1/projects/project-1/automation-adoptions',
            headers: { authorization: 'Bearer test' },
            payload: {
                ...encrypted, legacyMachineId: 'machine-1', legacyAutomationId: 'legacy-1',
                ownershipConfirmed: true, desiredPaused: false,
            },
        });
        expect(adopted.statusCode).toBe(200);
        expect(adopted.json()).toMatchObject({ migrationPending: true, desiredPaused: false });
        expect(mocks.adoptAutomation).toHaveBeenCalledWith({}, 'user-1', 'project-1', expect.objectContaining({
            legacyMachineId: 'machine-1', legacyAutomationId: 'legacy-1', payloadCiphertext,
        }));

        const activated = await app.inject({
            method: 'POST', url: '/v1/projects/project-1/automation-adoptions/automation-1/activate',
            headers: { authorization: 'Bearer test' }, payload: { expectedRevision: 1 },
        });
        expect(activated.statusCode).toBe(200);
        expect(mocks.activateAutomationAdoption).toHaveBeenCalledWith({}, 'user-1', 'project-1', 'automation-1', 1);
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
