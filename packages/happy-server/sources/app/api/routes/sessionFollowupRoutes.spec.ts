import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({
    createSessionFollowup: vi.fn(),
    deleteSessionFollowup: vi.fn(),
    getSessionFollowup: vi.fn(),
    listSessionFollowupHistory: vi.fn(),
    listSessionFollowups: vi.fn(),
    pauseSessionFollowup: vi.fn(),
    resumeSessionFollowup: vi.fn(),
    stopSessionFollowup: vi.fn(),
    emitProjectAutomationUpdate: vi.fn(),
}));

vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback({}) }));
vi.mock('@/app/automation/sessionFollowupService', () => mocks);
vi.mock('@/app/automation/automationUpdate', () => ({
    emitProjectAutomationUpdate: mocks.emitProjectAutomationUpdate,
}));

import { sessionFollowupRoutes } from './sessionFollowupRoutes';

const payload = new Uint8Array([1, ...new Uint8Array(40).fill(2)]);
const envelope = new Uint8Array([1, ...new Uint8Array(104).fill(3)]);

function record(patch: Record<string, unknown> = {}) {
    return {
        id: 'followup-1', projectId: 'project-1', ownerAccountId: 'user-1',
        machineAccountId: 'owner-1', machineId: 'machine-1', sessionId: 'session-1',
        revision: 1, generation: 1, step: 1, status: 'WAITING', terminalCode: null,
        totalRounds: 4, currentRound: 1, responseBoundarySeq: 10, lastObservedSeq: 10,
        payloadVersion: 1, payloadCiphertext: payload, viewerKeyId: 'viewer', viewerKeyVersion: 2,
        viewerKeyEnvelope: envelope, machineKeyVersion: 3, machineKeyEnvelope: envelope,
        completedAt: null, createdAt: new Date(1), updatedAt: new Date(2),
        ...patch,
    };
}

async function makeApp() {
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'user-1'; });
    sessionFollowupRoutes(app as unknown as Fastify);
    return app;
}

describe('sessionFollowupRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.SAYCODE_AUTOMATION_ENABLED = 'true';
    });
    afterEach(() => delete process.env.SAYCODE_AUTOMATION_ENABLED);

    it('starts an E2EE follow-up without passing plaintext to the service', async () => {
        mocks.createSessionFollowup.mockResolvedValue({ ok: true, value: record() });
        const app = await makeApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/projects/project-1/session-followups',
            headers: { authorization: 'Bearer test' },
            payload: {
                wireVersion: 1, sessionId: 'session-1', totalRounds: 4, currentRound: 1,
                responseBoundarySeq: 10, payloadVersion: 1,
                payloadCiphertext: Buffer.from(payload).toString('base64'),
                viewerKeyId: 'viewer', viewerKeyVersion: 2,
                viewerKeyEnvelope: Buffer.from(envelope).toString('base64'),
                machineKeyVersion: 3, machineKeyEnvelope: Buffer.from(envelope).toString('base64'),
            },
        });
        expect(response.statusCode).toBe(200);
        expect(mocks.createSessionFollowup).toHaveBeenCalledWith(
            {}, 'user-1', 'project-1', expect.objectContaining({
                sessionId: 'session-1', payloadCiphertext: payload,
            }),
        );
        const serviceInput = mocks.createSessionFollowup.mock.calls[0]![3];
        expect(serviceInput).not.toHaveProperty('prompt');
        expect(serviceInput).not.toHaveProperty('findings');
        expect(mocks.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-1',
            { projectId: 'project-1', reason: 'sync' },
            'user-1',
        );
    });

    it('uses revision-fenced stop and returns the latest safe status', async () => {
        const stopped = record({ revision: 2, generation: 2, status: 'CANCELLED', terminalCode: 'STOPPED' });
        mocks.stopSessionFollowup.mockResolvedValue({ ok: true, value: stopped });
        const app = await makeApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/projects/project-1/session-followups/followup-1/stop',
            headers: { authorization: 'Bearer test' },
            payload: { wireVersion: 1, expectedRevision: 1 },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(expect.objectContaining({
            id: 'followup-1', revision: 2, generation: 2, status: 'CANCELLED', terminalCode: 'STOPPED',
        }));
        expect(mocks.stopSessionFollowup).toHaveBeenCalledWith({}, 'user-1', 'project-1', 'followup-1', 1);
    });
});
