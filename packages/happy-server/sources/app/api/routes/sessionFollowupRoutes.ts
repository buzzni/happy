import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
    sessionFollowupCreateRequestSchema as createSchema,
    sessionFollowupRevisionRequestSchema as revisionSchema,
} from '@slopus/happy-wire';
import {
    createSessionFollowup,
    deleteSessionFollowup,
    getSessionFollowup,
    listSessionFollowupHistory,
    listSessionFollowups,
    pauseSessionFollowup,
    resumeSessionFollowup,
    stopSessionFollowup,
    type SessionFollowupServiceError,
} from '@/app/automation/sessionFollowupService';
import { emitProjectAutomationUpdate } from '@/app/automation/automationUpdate';
import { isServerBackedAutomationEnabled } from '@/app/automation/automationRollout';
import { inTx } from '@/storage/inTx';
import type { Fastify } from '../types';

const paramsSchema = z.object({ projectId: z.string().min(1) });
const itemParamsSchema = paramsSchema.extend({ followupId: z.string().min(1) });

function decode(value: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(value, 'base64'));
}

export function serializeSessionFollowup(row: any) {
    return {
        id: row.id,
        projectId: row.projectId,
        ownerAccountId: row.ownerAccountId,
        machineAccountId: row.machineAccountId,
        machineId: row.machineId,
        sessionId: row.sessionId,
        revision: row.revision,
        generation: row.generation,
        step: row.step,
        status: row.status,
        terminalCode: row.terminalCode,
        totalRounds: row.totalRounds,
        currentRound: row.currentRound,
        responseBoundarySeq: row.responseBoundarySeq,
        lastObservedSeq: row.lastObservedSeq,
        payloadVersion: row.payloadVersion,
        payloadCiphertext: Buffer.from(row.payloadCiphertext).toString('base64'),
        viewerKeyId: row.viewerKeyId,
        viewerKeyVersion: row.viewerKeyVersion,
        viewerKeyEnvelope: Buffer.from(row.viewerKeyEnvelope).toString('base64'),
        machineKeyVersion: row.machineKeyVersion,
        completedAt: row.completedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

function serializeHistory(row: any) {
    return {
        id: row.id,
        followupId: row.followupId,
        generation: row.generation,
        step: row.step,
        round: row.round,
        kind: row.kind,
        terminalCode: row.terminalCode,
        observedSeq: row.observedSeq,
        detailCiphertext: row.detailCiphertext
            ? Buffer.from(row.detailCiphertext).toString('base64')
            : null,
        createdAt: row.createdAt.getTime(),
    };
}

function status(error: SessionFollowupServiceError): number {
    if (error === 'not-found') return 404;
    if (error === 'forbidden') return 403;
    if (error === 'invalid-rounds' || error === 'invalid-boundary') return 400;
    return 409;
}

function sendError(reply: FastifyReply, result: { error: SessionFollowupServiceError; latest?: any }) {
    return reply.code(status(result.error)).send({
        error: result.error,
        ...(result.latest ? { latest: serializeSessionFollowup(result.latest) } : {}),
    });
}

function rejectWhenDisabled(reply: FastifyReply): boolean {
    if (isServerBackedAutomationEnabled()) return false;
    void reply.code(404).send({ error: 'feature-disabled' });
    return true;
}

async function announce(userId: string, projectId: string) {
    await emitProjectAutomationUpdate(projectId, { projectId, reason: 'sync' }, userId);
}

export function sessionFollowupRoutes(app: Fastify) {
    app.get('/v1/projects/:projectId/session-followups', {
        preHandler: app.authenticate,
        schema: {
            params: paramsSchema,
            querystring: z.object({
                session_id: z.string().min(1).optional(),
                limit: z.coerce.number().int().min(1).max(100).default(20),
            }),
        },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => listSessionFollowups(tx, request.userId, request.params.projectId, {
            ...(request.query.session_id ? { sessionId: request.query.session_id } : {}),
            limit: request.query.limit,
        }));
        if (!result.ok) return sendError(reply, result);
        return reply.send(result.value.map(serializeSessionFollowup));
    });

    app.get('/v1/projects/:projectId/session-followups/:followupId', {
        preHandler: app.authenticate,
        schema: { params: itemParamsSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => getSessionFollowup(
            tx, request.userId, request.params.projectId, request.params.followupId,
        ));
        if (!result.ok) return sendError(reply, result);
        return reply.send(serializeSessionFollowup(result.value));
    });

    app.get('/v1/projects/:projectId/session-followups/:followupId/history', {
        preHandler: app.authenticate,
        schema: {
            params: itemParamsSchema,
            querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
        },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => listSessionFollowupHistory(
            tx, request.userId, request.params.projectId, request.params.followupId, request.query.limit,
        ));
        if (!result.ok) return sendError(reply, result);
        return reply.send(result.value.map(serializeHistory));
    });

    app.post('/v1/projects/:projectId/session-followups', {
        preHandler: app.authenticate,
        schema: { params: paramsSchema, body: createSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const body = request.body;
        const result = await inTx((tx) => createSessionFollowup(tx, request.userId, request.params.projectId, {
            sessionId: body.sessionId,
            totalRounds: body.totalRounds,
            currentRound: body.currentRound,
            responseBoundarySeq: body.responseBoundarySeq,
            payloadVersion: body.payloadVersion,
            payloadCiphertext: decode(body.payloadCiphertext),
            viewerKeyId: body.viewerKeyId,
            viewerKeyVersion: body.viewerKeyVersion,
            viewerKeyEnvelope: decode(body.viewerKeyEnvelope),
            machineKeyVersion: body.machineKeyVersion,
            machineKeyEnvelope: decode(body.machineKeyEnvelope),
        }));
        if (!result.ok) return sendError(reply, result);
        await announce(request.userId, request.params.projectId);
        return reply.send(serializeSessionFollowup(result.value));
    });

    const action = (
        path: 'pause' | 'resume' | 'stop',
        operation: typeof pauseSessionFollowup,
    ) => app.post(`/v1/projects/:projectId/session-followups/:followupId/${path}`, {
        preHandler: app.authenticate,
        schema: { params: itemParamsSchema, body: revisionSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => operation(
            tx, request.userId, request.params.projectId,
            request.params.followupId, request.body.expectedRevision,
        ));
        if (!result.ok) return sendError(reply, result);
        await announce(request.userId, request.params.projectId);
        return reply.send(serializeSessionFollowup(result.value));
    });
    action('pause', pauseSessionFollowup);
    action('resume', resumeSessionFollowup);
    action('stop', stopSessionFollowup);

    app.delete('/v1/projects/:projectId/session-followups/:followupId', {
        preHandler: app.authenticate,
        schema: { params: itemParamsSchema, body: revisionSchema },
    }, async (request, reply) => {
        if (rejectWhenDisabled(reply)) return;
        const result = await inTx((tx) => deleteSessionFollowup(
            tx, request.userId, request.params.projectId,
            request.params.followupId, request.body.expectedRevision,
        ));
        if (!result.ok) return sendError(reply, result);
        await announce(request.userId, request.params.projectId);
        return reply.send(serializeSessionFollowup(result.value));
    });
}
