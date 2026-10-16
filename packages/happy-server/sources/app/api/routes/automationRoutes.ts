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
    createRegisteredAutomation,
    getRegisteredAutomation,
    deleteAutomation,
    getAutomationTarget,
    listAutomationRuns,
    listAutomations,
    getAutomationManagement,
    replaceAutomationViewerKeyIfUnused,
    requestAutomationRun,
    setAutomationViewerKey,
    updateAutomation,
    type AutomationUpdateInput,
    type AutomationServiceError,
} from '@/app/automation/automationService';
import { resolveAutomationRunMcpContext } from '@/app/automation/automationExecutionService';
import { listAutomationPage } from '@/app/automation/automationPageService';
import { readChatAutomationImpact, transitionChatAutomations } from '@/app/automation/automationChatLifecycle';
import { verifyChatAutomationLifecycle } from '@slopus/happy-wire/chatAutomationLifecycleToken';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { isServerBackedAutomationEnabled } from '@/app/automation/automationRollout';
import { emitAutomationUpdate, emitProjectAutomationUpdate } from '@/app/automation/automationUpdate';
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
        runRequestedAt: row.runRequestedAt?.getTime() ?? null,
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
        failureCode: row.failureCode,
        degradedCode: row.degradedCode,
        queueDepth: row.queueDepth,
        queuePosition: row.queuePosition,
        queueTotal: row.queueTotal,
        queueEstimatedAt: row.queueEstimatedAt?.getTime() ?? null,
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

function rejectWhenDisabled(reply: FastifyReply): boolean {
    if (isServerBackedAutomationEnabled()) return false;
    void reply.code(404).send({ error: 'feature-disabled' });
    return true;
}

export function automationRoutes(app: Fastify) {
    const lifecycleProof = (authorization: unknown, proof: unknown, projectId: string, state: 'impact' | 'active' | 'archived' | 'deleted') => typeof authorization === 'string' && typeof proof === 'string' && verifyChatAutomationLifecycle({
        token: proof, bearer: authorization.replace(/^Bearer /i, ''), projectId, state, now: Date.now(),
        secret: process.env.SCRIPT_AUTOMATION_ADMISSION_SECRET || (process.env.HAPPY_STANDALONE_CONTROL === 'stdin-v1' ? process.env.HANDY_MASTER_SECRET : '') || '',
    });
    app.get('/v1/projects/:projectId/automation-impact', { preHandler: app.authenticate, schema: { params: paramsSchema } }, async (request, reply) => {
        if (!lifecycleProof(request.headers.authorization, request.headers['x-chat-automation-proof'], request.params.projectId, 'impact')) return reply.code(403).send({ error: 'CHAT_AUTOMATION_OWNER_PROOF_REQUIRED' });
        try { return reply.send(await inTx(tx => readChatAutomationImpact(tx, request.userId, request.params.projectId))); }
        catch (error) { if (error instanceof Error && error.message === 'CHAT_AUTOMATIONS_FORBIDDEN') return reply.code(403).send({ error: error.message }); throw error; }
    });
    app.post('/v1/projects/:projectId/automation-lifecycle', { preHandler: app.authenticate, schema: { params: paramsSchema, body: z.object({ state: z.enum(['active', 'archived', 'deleted']) }) } }, async (request, reply) => {
        if (!lifecycleProof(request.headers.authorization, request.headers['x-chat-automation-proof'], request.params.projectId, request.body.state)) return reply.code(403).send({ error: 'CHAT_AUTOMATION_OWNER_PROOF_REQUIRED' });
        try {
            const result = await inTx(tx => transitionChatAutomations(tx, request.userId, request.params.projectId, request.body.state));
            await emitProjectAutomationUpdate(request.params.projectId, { projectId: request.params.projectId, reason: request.body.state === 'deleted' ? 'delete' : 'upsert' }, request.userId);
            return reply.send(result);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('CHAT_AUTOMATIONS_')) return reply.code(error.message.endsWith('FORBIDDEN') ? 403 : 409).send({ error: error.message });
            throw error;
        }
    });
    app.post('/v1/automation-runs/:runId/mcp-context', {
        preHandler: app.authenticate,
        schema: { params: runParamsSchema, body: mcpContextSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
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

    // Read-only views use independent queries; write routes retain Serializable transactions.
    app.get('/v1/projects/:projectId/automation-target', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await getAutomationTarget(db, request.userId, request.params.projectId);
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
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => setAutomationViewerKey(tx, request.userId, request.params.projectId, {
            expectedKeyVersion: request.body.expectedKeyVersion,
            publicKey: decode(request.body.publicKey),
        }));
        if (!result.ok) return sendError(reply, result);
        await emitProjectAutomationUpdate(
            request.params.projectId,
            { projectId: request.params.projectId, reason: 'viewer-key' },
            request.userId,
        );
        return reply.send(result.value);
    });

    app.put('/v1/projects/:projectId/automation-viewer-key/replace-if-unused', {
        preHandler: app.authenticate,
        schema: {
            params: paramsSchema,
            body: viewerKeySchema,
        },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => replaceAutomationViewerKeyIfUnused(
            tx,
            request.userId,
            request.params.projectId,
            {
                expectedKeyVersion: request.body.expectedKeyVersion,
                publicKey: decode(request.body.publicKey),
            },
        ));
        if (!result.ok) return sendError(reply, result);
        await emitProjectAutomationUpdate(
            request.params.projectId,
            { projectId: request.params.projectId, reason: 'viewer-key' },
            request.userId,
        );
        return reply.send(result.value);
    });

    // Read-only bulk scope discovery; the database still enforces project access.
    app.post('/v1/automations/page', {
        preHandler: app.authenticate,
        schema: { body: z.object({ projectIds: z.array(z.string().min(1).max(256)).max(10000),
            limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(1024).nullable().default(null) }) },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        try {
            const page = await listAutomationPage(db, request.userId, request.body);
            return reply.send({ automations: page.automations.map(row => ({ ...serializeAutomation(row), runs: row.runs.map(serializeRun) })), nextCursor: page.nextCursor });
        } catch (error) {
            if (error instanceof Error && error.message === 'invalid-automation-cursor') return reply.code(400).send({ error: error.message });
            throw error;
        }
    });

    app.get('/v1/machines/:machineId/automation-reader-key', {
        preHandler: app.authenticate, schema: { params: z.object({ machineId: z.string().min(1) }) },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const machine = await db.machine.findUnique({ where: { accountId_id: { accountId: request.userId, id: request.params.machineId } },
            select: { id: true, automationPublicKey: true, automationKeyVersion: true } });
        if (!machine) return reply.code(404).send({ error: 'not-found' });
        if (!machine.automationPublicKey || machine.automationKeyVersion < 1) return reply.code(409).send({ error: 'machine-key-unavailable' });
        return reply.header('Cache-Control', 'no-store').send({ machineId: machine.id, machineAccountId: request.userId,
            publicKey: Buffer.from(machine.automationPublicKey).toString('base64'), keyVersion: machine.automationKeyVersion });
    });

    app.get('/v1/projects/:projectId/automations', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await listAutomations(db, request.userId, request.params.projectId);
        if (!result.ok) return sendError(reply, result);
        return reply.send({ automations: result.value.map(serializeAutomation) });
    });

    app.get('/v1/projects/:projectId/automations/:automationId/management', {
        preHandler: app.authenticate,
        schema: { params: automationParamsSchema, querystring: z.object({ machineId: z.string().min(1) }).strict() },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await getAutomationManagement(db, request.userId, request.params.projectId, request.params.automationId, request.query.machineId);
        if (!result.ok) return sendError(reply, result);
        return reply.header('Cache-Control', 'no-store').send({ automation: { ...serializeAutomation(result.value),
            machineKeyEnvelope: Buffer.from(result.value.machineKeyEnvelope).toString('base64') } });
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
        if (rejectWhenDisabled(reply)) return;
        const result = await listAutomationRuns(db, request.userId, request.params.projectId, request.query);
        if (!result.ok) return sendError(reply, result);
        return reply.send({ runs: result.value.map(serializeRun) });
    });

    const registrationParams = paramsSchema.extend({ registrationKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) });
    app.get('/v1/projects/:projectId/automations/registrations/:registrationKey', {
        preHandler: app.authenticate, schema: { params: registrationParams },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx(tx => getRegisteredAutomation(tx, request.userId, request.params.projectId, request.params.registrationKey));
        if (!result.ok) return sendError(reply, result);
        return reply.send({ automation: result.value ? serializeAutomation(result.value) : null });
    });
    app.put('/v1/projects/:projectId/automations/registrations/:registrationKey', {
        preHandler: app.authenticate, schema: { params: registrationParams, body: createSchema.extend({ payloadVersion: z.literal(4), paused: z.literal(true) }).strict() },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const body = request.body;
        const result = await inTx(tx => createRegisteredAutomation(tx, request.userId, request.params.projectId, request.params.registrationKey, {
            ...body, payloadCiphertext: decode(body.payloadCiphertext), viewerKeyEnvelope: decode(body.viewerKeyEnvelope), machineKeyEnvelope: decode(body.machineKeyEnvelope),
        }));
        if (!result.ok) return sendError(reply, result);
        await emitAutomationUpdate(request.userId, { projectId: request.params.projectId, automationId: result.value.id,
            revision: result.value.revision, generation: result.value.generation, reason: 'upsert' });
        return reply.send({ automation: serializeAutomation(result.value) });
    });

    app.post('/v1/projects/:projectId/automations', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema, body: createSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
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
        if (rejectWhenDisabled(reply)) return;
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
        if (rejectWhenDisabled(reply)) return;
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
        if (rejectWhenDisabled(reply)) return;
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

    app.post('/v1/projects/:projectId/automations/:automationId/run', {
        preHandler: app.authenticate,
        schema: { params: automationParamsSchema, body: deleteSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => requestAutomationRun(
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
            reason: 'run',
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
        if (rejectWhenDisabled(reply)) return;
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
