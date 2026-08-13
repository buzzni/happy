import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
    createAgentProfile,
    deleteAgentProfile,
    listAgentProfiles,
    updateAgentProfile,
} from '@/app/agentProfile/agentProfileService';
import { inTx } from '@/storage/inTx';
import type { Fastify } from '../types';

const agentSchema = z.enum(['claude', 'codex', 'gemini', 'opencode', 'openclaw']);
const profileInputSchema = z.object({
    name: z.string().trim().min(1).max(80),
    agent: agentSchema,
    model: z.string().trim().min(1).max(120).nullable().optional(),
    worktreeEnabled: z.boolean(),
    activate: z.boolean().optional(),
});
const profileUpdateSchema = profileInputSchema.partial();
const profileParamsSchema = z.object({ profileId: z.string().min(1) });

function serializeProfile(profile: {
    id: string;
    name: string;
    agent: string;
    model: string | null;
    worktreeEnabled: boolean;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: profile.id,
        name: profile.name,
        agent: profile.agent,
        model: profile.model,
        worktreeEnabled: profile.worktreeEnabled,
        active: profile.active,
        createdAt: profile.createdAt.getTime(),
        updatedAt: profile.updatedAt.getTime(),
    };
}

function profileConflict(error: unknown): 'name-conflict' | 'active-conflict' | null {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        return null;
    }
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    return fields.includes('name') || fields.includes('AgentLaunchProfile_accountId_name_key')
        ? 'name-conflict'
        : 'active-conflict';
}

export function agentProfileRoutes(app: Fastify) {
    app.get('/v1/account/agent-profiles', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const profiles = await inTx((tx) => listAgentProfiles(tx, request.userId));
        return reply.send({ profiles: profiles.map(serializeProfile) });
    });

    app.post('/v1/account/agent-profiles', {
        preHandler: app.authenticate,
        schema: { body: profileInputSchema },
    }, async (request, reply) => {
        try {
            const profile = await inTx((tx) => createAgentProfile(tx, request.userId, request.body));
            return reply.code(201).send({ profile: serializeProfile(profile) });
        } catch (error) {
            const conflict = profileConflict(error);
            if (conflict) return reply.code(409).send({ error: conflict });
            throw error;
        }
    });

    app.patch('/v1/account/agent-profiles/:profileId', {
        preHandler: app.authenticate,
        schema: { params: profileParamsSchema, body: profileUpdateSchema },
    }, async (request, reply) => {
        try {
            const result = await inTx((tx) => updateAgentProfile(
                tx,
                request.userId,
                request.params.profileId,
                request.body,
            ));
            if (!result.ok) return reply.code(404).send({ error: result.error });
            return reply.send({ profile: serializeProfile(result.value) });
        } catch (error) {
            const conflict = profileConflict(error);
            if (conflict) return reply.code(409).send({ error: conflict });
            throw error;
        }
    });

    app.delete('/v1/account/agent-profiles/:profileId', {
        preHandler: app.authenticate,
        schema: { params: profileParamsSchema },
    }, async (request, reply) => {
        const result = await inTx((tx) => deleteAgentProfile(
            tx,
            request.userId,
            request.params.profileId,
        ));
        if (!result.ok) return reply.code(404).send({ error: result.error });
        return reply.send({
            ok: true,
            activeProfile: result.activeProfile ? serializeProfile(result.activeProfile) : null,
        });
    });
}
