import fastify from 'fastify';
import { Prisma } from '@prisma/client';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const serviceMocks = vi.hoisted(() => ({
    listAgentProfiles: vi.fn(),
    createAgentProfile: vi.fn(),
    updateAgentProfile: vi.fn(),
    deleteAgentProfile: vi.fn(),
}));

vi.mock('@/app/agentProfile/agentProfileService', () => serviceMocks);
vi.mock('@/storage/inTx', () => ({ inTx: (fn: (tx: object) => unknown) => fn({}) }));

import { agentProfileRoutes } from './agentProfileRoutes';

const profile = {
    id: 'profile-1',
    accountId: 'account-1',
    name: '기본 작업',
    agent: 'codex',
    model: 'default',
    worktreeEnabled: true,
    active: true,
    createdAt: new Date('2026-08-13T00:00:00.000Z'),
    updatedAt: new Date('2026-08-13T00:01:00.000Z'),
};

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    agentProfileRoutes(typed);
    await typed.ready();
    return typed;
}

describe('agentProfileRoutes', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects unauthenticated profile reads', async () => {
        const app = await createApp();

        const response = await app.inject({ method: 'GET', url: '/v1/account/agent-profiles' });

        expect(response.statusCode).toBe(401);
        expect(serviceMocks.listAgentProfiles).not.toHaveBeenCalled();
        await app.close();
    });

    it('creates a profile under the authenticated personal account', async () => {
        serviceMocks.createAgentProfile.mockResolvedValue(profile);
        const app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/agent-profiles',
            headers: { 'x-user-id': 'account-1' },
            payload: {
                name: '기본 작업',
                agent: 'codex',
                model: 'default',
                worktreeEnabled: true,
            },
        });

        expect(response.statusCode).toBe(201);
        expect(serviceMocks.createAgentProfile).toHaveBeenCalledWith(
            {},
            'account-1',
            expect.objectContaining({ name: '기본 작업', agent: 'codex' }),
        );
        expect(response.json().profile).toMatchObject({
            id: 'profile-1',
            createdAt: profile.createdAt.getTime(),
            updatedAt: profile.updatedAt.getTime(),
        });
        await app.close();
    });

    it('maps only the profile-name unique constraint to name-conflict', async () => {
        serviceMocks.createAgentProfile.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('duplicate profile name', {
                code: 'P2002',
                clientVersion: 'test',
                meta: { target: ['accountId', 'name'] },
            }),
        );
        const app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/agent-profiles',
            headers: { 'x-user-id': 'account-1' },
            payload: {
                name: '기본 작업',
                agent: 'codex',
                worktreeEnabled: true,
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'name-conflict' });
        await app.close();
    });

    it('does not misreport the active-profile unique constraint as a name conflict', async () => {
        serviceMocks.createAgentProfile.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('concurrent active profile', {
                code: 'P2002',
                clientVersion: 'test',
                meta: { target: 'AgentLaunchProfile_one_active_per_account_idx' },
            }),
        );
        const app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/agent-profiles',
            headers: { 'x-user-id': 'account-1' },
            payload: {
                name: '동시 작업',
                agent: 'codex',
                worktreeEnabled: true,
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'active-conflict' });
        await app.close();
    });

    it('returns the fallback active profile after deletion', async () => {
        serviceMocks.deleteAgentProfile.mockResolvedValue({ ok: true, activeProfile: profile });
        const app = await createApp();

        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/account/agent-profiles/profile-old',
            headers: { 'x-user-id': 'account-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(serviceMocks.deleteAgentProfile).toHaveBeenCalledWith(
            {},
            'account-1',
            'profile-old',
        );
        expect(response.json()).toEqual({
            ok: true,
            activeProfile: {
                id: profile.id,
                name: profile.name,
                agent: profile.agent,
                model: profile.model,
                worktreeEnabled: profile.worktreeEnabled,
                active: profile.active,
                createdAt: profile.createdAt.getTime(),
                updatedAt: profile.updatedAt.getTime(),
            },
        });
        await app.close();
    });
});
