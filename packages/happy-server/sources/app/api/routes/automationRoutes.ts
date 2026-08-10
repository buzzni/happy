import type { Automation, AutomationRun } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
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
import { inTx } from '@/storage/inTx';
import type { Fastify } from '../types';

const paramsSchema = z.object({ projectId: z.string().min(1) });
const automationParamsSchema = paramsSchema.extend({ automationId: z.string().min(1) });

function base64Bytes(maxBytes: number) {
    return z.string().min(1).max(Math.ceil(maxBytes / 3) * 4 + 4)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
        .refine((value) => Buffer.from(value, 'base64').byteLength <= maxBytes, 'decoded value is too large');
}

const publicKeySchema = base64Bytes(32).refine((value) => Buffer.from(value, 'base64').byteLength === 32);
const payloadCiphertextSchema = base64Bytes(128 * 1024);
const envelopeSchema = base64Bytes(512);
const encryptedFields = {
    payloadVersion: z.literal(1),
    payloadCiphertext: payloadCiphertextSchema,
    viewerKeyId: z.string().min(1).max(128),
    viewerKeyVersion: z.number().int().min(1),
    viewerKeyEnvelope: envelopeSchema,
    machineKeyVersion: z.number().int().min(1),
    machineKeyEnvelope: envelopeSchema,
};
const createSchema = z.object({ ...encryptedFields, paused: z.boolean().default(false) });
const updateSchema = z.object({
    expectedRevision: z.number().int().min(1),
    paused: z.boolean().optional(),
    payloadVersion: encryptedFields.payloadVersion.optional(),
    payloadCiphertext: encryptedFields.payloadCiphertext.optional(),
    viewerKeyId: encryptedFields.viewerKeyId.optional(),
    viewerKeyVersion: encryptedFields.viewerKeyVersion.optional(),
    viewerKeyEnvelope: encryptedFields.viewerKeyEnvelope.optional(),
    machineKeyVersion: encryptedFields.machineKeyVersion.optional(),
    machineKeyEnvelope: encryptedFields.machineKeyEnvelope.optional(),
}).superRefine((value, ctx) => {
    const present = Object.keys(encryptedFields).filter((key) => value[key as keyof typeof value] !== undefined).length;
    if (present === 0 && value.paused === undefined) {
        ctx.addIssue({ code: 'custom', message: 'patch must change paused or encrypted payload' });
    }
    if (present !== 0 && present !== Object.keys(encryptedFields).length) {
        ctx.addIssue({ code: 'custom', message: 'encrypted payload fields must be replaced together' });
    }
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

export function automationRoutes(app: Fastify) {
    app.get('/v1/projects/:projectId/automation-target', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema },
    }, async (request, reply) => {
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
            body: z.object({ expectedKeyVersion: z.number().int().min(0), publicKey: publicKeySchema }),
        },
    }, async (request, reply) => {
        const result = await inTx((tx) => setAutomationViewerKey(tx, request.userId, request.params.projectId, {
            expectedKeyVersion: request.body.expectedKeyVersion,
            publicKey: decode(request.body.publicKey),
        }));
        if (!result.ok) return sendError(reply, result);
        return reply.send(result.value);
    });

    app.get('/v1/projects/:projectId/automations', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema },
    }, async (request, reply) => {
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
        const result = await inTx((tx) => listAutomationRuns(tx, request.userId, request.params.projectId, request.query));
        if (!result.ok) return sendError(reply, result);
        return reply.send({ runs: result.value.map(serializeRun) });
    });

    app.post('/v1/projects/:projectId/automations', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema, body: createSchema },
    }, async (request, reply) => {
        const result = await inTx((tx) => createAutomation(tx, request.userId, request.params.projectId, {
            ...request.body,
            payloadCiphertext: decode(request.body.payloadCiphertext),
            viewerKeyEnvelope: decode(request.body.viewerKeyEnvelope),
            machineKeyEnvelope: decode(request.body.machineKeyEnvelope),
        }));
        if (!result.ok) return sendError(reply, result);
        return reply.send({ automation: serializeAutomation(result.value) });
    });

    app.patch('/v1/projects/:projectId/automations/:automationId', {
        preHandler: app.authenticate,
        schema: { params: automationParamsSchema, body: updateSchema },
    }, async (request, reply) => {
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
        return reply.send({ automation: serializeAutomation(result.value) });
    });

    app.delete('/v1/projects/:projectId/automations/:automationId', {
        preHandler: app.authenticate,
        schema: {
            params: automationParamsSchema,
            body: z.object({ expectedRevision: z.number().int().min(1) }),
        },
    }, async (request, reply) => {
        const result = await inTx((tx) => deleteAutomation(
            tx,
            request.userId,
            request.params.projectId,
            request.params.automationId,
            request.body.expectedRevision,
        ));
        if (!result.ok) return sendError(reply, result);
        return reply.send({ automation: serializeAutomation(result.value) });
    });
}
