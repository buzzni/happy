import type { Automation, AutomationRun } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
    automationActivateAdoptionRequestSchema as activateAdoptionSchema,
    automationAdoptRequestSchema as adoptSchema,
    automationCreateRequestSchema as createSchema,
    automationDeleteRequestSchema as deleteSchema,
    automationUpdateRequestSchema as updateSchema,
    automationViewerKeyRequestSchema as viewerKeySchema,
} from '@slopus/happy-wire';
import {
    activateAutomationAdoption,
    adoptAutomation,
    createAutomation,
    deleteAutomation,
    getAutomationTarget,
    listAutomationRuns,
    listAutomations,
    setAutomationViewerKey,
    updateAutomation,
    type AutomationUpdateInput,
    type AutomationServiceError,
} from '@/app/automation/automationService';
import { resolveAutomationRunMcpContext } from '@/app/automation/automationExecutionService';
import { inTx } from '@/storage/inTx';
import { isServerBackedAutomationEnabled } from '@/app/automation/automationRollout';
import { emitAutomationUpdate } from '@/app/automation/automationUpdate';
import type { Fastify } from '../types';

const paramsSchema = z.object({ projectId: z.string().min(1) });
const automationParamsSchema = paramsSchema.extend({ automationId: z.string().min(1) });
const runParamsSchema = z.object({ runId: z.string().min(1) });
const mcpContextSchema = z.object({
    machineId: z.string().min(1),
    claimToken: z.string().min(1).max(256),
    sessionId: z.string().min(1).optional(),
});

function decode(value: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(value, 'base64'));
}

function serializeAutomation(row: Automation) {
    return {
        id: row.id,
        projectId: row.projectId,
        ownerAccountId: row.ownerAccountId,
        machineAccountId: row.machineAccountId,
        machineId: row.machineId,
        revision: row.revision,
        generation: row.generation,
        payloadVersion: row.payloadVersion,
        payloadCiphertext: Buffer.from(row.payloadCiphertext).toString('base64'),
        viewerKeyId: row.viewerKeyId,
        viewerKeyVersion: row.viewerKeyVersion,
        viewerKeyEnvelope: Buffer.from(row.viewerKeyEnvelope).toString('base64'),
        machineKeyVersion: row.machineKeyVersion,
        paused: row.paused,
        enabledAt: row.enabledAt.getTime(),
        appliedRevision: row.appliedRevision,
        appliedAt: row.appliedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

function serializeRun(row: AutomationRun) {
    return {
        id: row.id,
        automationId: row.automationId,
        generation: row.generation,
        scheduledFor: row.scheduledFor.getTime(),
        machineId: row.machineId,
        status: row.status,
        sessionId: row.sessionId,
        outcome: row.outcome,
        detailCiphertext: row.detailCiphertext ? Buffer.from(row.detailCiphertext).toString('base64') : null,
        claimedAt: row.claimedAt.getTime(),
        startedAt: row.startedAt?.getTime() ?? null,
        completedAt: row.completedAt?.getTime() ?? null,
        lateReport: row.lateReport,
    };
}

function errorStatus(error: AutomationServiceError): number {
    if (error === 'not-found') return 404;
    if (error === 'forbidden') return 403;
    if (error === 'invalid-payload-update') return 400;
    return 409;
}

function sendError(reply: FastifyReply, result: {
    error: AutomationServiceError;
    latest?: Automation;
}) {
    return reply.code(errorStatus(result.error)).send({
        error: result.error,
        ...(result.latest ? { latest: serializeAutomation(result.latest) } : {}),
    });
}

function rejectWhenDisabled(accountId: string, reply: FastifyReply): boolean {
    if (isServerBackedAutomationEnabled(accountId)) return false;
    void reply.code(404).send({ error: 'feature-disabled' });
    return true;
}

export function automationRoutes(app: Fastify) {
    app.post('/v1/automation-runs/:runId/mcp-context', {
        preHandler: app.authenticate,
        schema: { params: runParamsSchema, body: mcpContextSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => resolveAutomationRunMcpContext(
            tx,
            request.userId,
            request.body.machineId,
            {
                runId: request.params.runId,
                claimToken: request.body.claimToken,
                ...(request.body.sessionId ? { sessionId: request.body.sessionId } : {}),
            },
        ));
        if (!result.ok) {
            return reply.code(result.error === 'claim-not-found' ? 404 : 409).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    app.get('/v1/projects/:projectId/automation-target', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => getAutomationTarget(tx, request.userId, request.params.projectId));
        if (!result.ok) return sendError(reply, result);
        return reply.send({
            target: {
                ...result.value,
                machinePublicKey: Buffer.from(result.value.machinePublicKey).toString('base64'),
                viewerPublicKey: result.value.viewerPublicKey
                    ? Buffer.from(result.value.viewerPublicKey).toString('base64')
                    : null,
            },
        });
    });

    app.put('/v1/projects/:projectId/automation-viewer-key', {
        preHandler: app.authenticate,
        schema: {
            params: paramsSchema,
            body: viewerKeySchema,
        },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => setAutomationViewerKey(tx, request.userId, request.params.projectId, {
            expectedKeyVersion: request.body.expectedKeyVersion,
            publicKey: decode(request.body.publicKey),
        }));
        if (!result.ok) return sendError(reply, result);
        await emitAutomationUpdate(request.userId, {
            projectId: request.params.projectId,
            reason: 'viewer-key',
        });
        return reply.send(result.value);
    });

    app.get('/v1/projects/:projectId/automations', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => listAutomations(tx, request.userId, request.params.projectId));
        if (!result.ok) return sendError(reply, result);
        return reply.send({ automations: result.value.map(serializeAutomation) });
    });

    app.get('/v1/projects/:projectId/automation-runs', {
        preHandler: app.authenticate,
        schema: {
            params: paramsSchema,
            querystring: z.object({
                automationId: z.string().min(1).optional(),
                limit: z.coerce.number().int().min(1).max(100).default(20),
            }),
        },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => listAutomationRuns(tx, request.userId, request.params.projectId, request.query));
        if (!result.ok) return sendError(reply, result);
        return reply.send({ runs: result.value.map(serializeRun) });
    });

    app.post('/v1/projects/:projectId/automations', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema, body: createSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => createAutomation(tx, request.userId, request.params.projectId, {
            ...request.body,
            payloadCiphertext: decode(request.body.payloadCiphertext),
            viewerKeyEnvelope: decode(request.body.viewerKeyEnvelope),
            machineKeyEnvelope: decode(request.body.machineKeyEnvelope),
        }));
        if (!result.ok) return sendError(reply, result);
        await emitAutomationUpdate(request.userId, {
            projectId: request.params.projectId,
            automationId: result.value.id,
            revision: result.value.revision,
            generation: result.value.generation,
            reason: 'upsert',
        });
        return reply.send({ automation: serializeAutomation(result.value) });
    });

    app.post('/v1/projects/:projectId/automation-adoptions', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema, body: adoptSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const body = request.body;
        const result = await inTx((tx) => adoptAutomation(tx, request.userId, request.params.projectId, {
            ...body,
            payloadCiphertext: decode(body.payloadCiphertext),
            viewerKeyEnvelope: decode(body.viewerKeyEnvelope),
            machineKeyEnvelope: decode(body.machineKeyEnvelope),
        }));
        if (!result.ok) return sendError(reply, result);
        await emitAutomationUpdate(request.userId, {
            projectId: request.params.projectId,
            automationId: result.value.id,
            revision: result.value.revision,
            generation: result.value.generation,
            reason: 'upsert',
        });
        return reply.send({
            automation: serializeAutomation(result.value),
            migrationPending: result.value.legacyMigrationPending,
            desiredPaused: result.value.legacyDesiredPaused,
        });
    });

    app.post('/v1/projects/:projectId/automation-adoptions/:automationId/activate', {
        preHandler: app.authenticate,
        schema: { params: automationParamsSchema, body: activateAdoptionSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => activateAutomationAdoption(
            tx,
            request.userId,
            request.params.projectId,
            request.params.automationId,
            request.body.expectedRevision,
        ));
        if (!result.ok) return sendError(reply, result);
        await emitAutomationUpdate(request.userId, {
            projectId: request.params.projectId,
            automationId: result.value.id,
            revision: result.value.revision,
            generation: result.value.generation,
            reason: 'upsert',
        });
        return reply.send({ automation: serializeAutomation(result.value) });
    });

    app.patch('/v1/projects/:projectId/automations/:automationId', {
        preHandler: app.authenticate,
        schema: { params: automationParamsSchema, body: updateSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const body = request.body;
        const input: AutomationUpdateInput = {
            expectedRevision: body.expectedRevision,
            ...(body.paused !== undefined ? { paused: body.paused } : {}),
            ...(body.payloadVersion !== undefined ? {
                payloadVersion: body.payloadVersion,
                payloadCiphertext: decode(body.payloadCiphertext!),
                viewerKeyId: body.viewerKeyId!,
                viewerKeyVersion: body.viewerKeyVersion!,
                viewerKeyEnvelope: decode(body.viewerKeyEnvelope!),
                machineKeyVersion: body.machineKeyVersion!,
                machineKeyEnvelope: decode(body.machineKeyEnvelope!),
            } : {}),
        };
        const result = await inTx((tx) => updateAutomation(
            tx,
            request.userId,
            request.params.projectId,
            request.params.automationId,
            input,
        ));
        if (!result.ok) return sendError(reply, result);
        await emitAutomationUpdate(request.userId, {
            projectId: request.params.projectId,
            automationId: result.value.id,
            revision: result.value.revision,
            generation: result.value.generation,
            reason: 'upsert',
        });
        return reply.send({ automation: serializeAutomation(result.value) });
    });

    app.delete('/v1/projects/:projectId/automations/:automationId', {
        preHandler: app.authenticate,
        schema: {
            params: automationParamsSchema,
            body: deleteSchema,
        },
    }, async (request, reply) => {
        if (rejectWhenDisabled(request.userId, reply)) return;
        const result = await inTx((tx) => deleteAutomation(
            tx,
            request.userId,
            request.params.projectId,
            request.params.automationId,
            request.body.expectedRevision,
        ));
        if (!result.ok) return sendError(reply, result);
        await emitAutomationUpdate(request.userId, {
            projectId: request.params.projectId,
            automationId: result.value.id,
            revision: result.value.revision,
            generation: result.value.generation,
            reason: 'delete',
        });
        return reply.send({ automation: serializeAutomation(result.value) });
    });
}
