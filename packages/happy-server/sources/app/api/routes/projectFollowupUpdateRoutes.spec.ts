import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({
    projectCreate: vi.fn(),
    projectList: vi.fn(async () => []),
    projectGet: vi.fn(),
    projectUpdate: vi.fn(),
    projectDelete: vi.fn(),
    projectMemberInvite: vi.fn(),
    projectMemberList: vi.fn(),
    projectMemberRespond: vi.fn(),
    projectMemberUpdate: vi.fn(),
    projectMemberRemove: vi.fn(),
    projectMemberPending: vi.fn(async () => []),
    emitProjectAutomationUpdate: vi.fn(async () => undefined),
}));

vi.mock('@/app/project/projectCreate', () => ({ projectCreate: mocks.projectCreate }));
vi.mock('@/app/project/projectList', () => ({ projectList: mocks.projectList }));
vi.mock('@/app/project/projectGet', () => ({ projectGet: mocks.projectGet }));
vi.mock('@/app/project/projectUpdate', () => ({ projectUpdate: mocks.projectUpdate }));
vi.mock('@/app/project/projectDelete', () => ({ projectDelete: mocks.projectDelete }));
vi.mock('@/app/project/projectMemberInvite', () => ({ projectMemberInvite: mocks.projectMemberInvite }));
vi.mock('@/app/project/projectMemberList', () => ({ projectMemberList: mocks.projectMemberList }));
vi.mock('@/app/project/projectMemberRespond', () => ({ projectMemberRespond: mocks.projectMemberRespond }));
vi.mock('@/app/project/projectMemberUpdate', () => ({ projectMemberUpdate: mocks.projectMemberUpdate }));
vi.mock('@/app/project/projectMemberRemove', () => ({ projectMemberRemove: mocks.projectMemberRemove }));
vi.mock('@/app/project/projectMemberPending', () => ({ projectMemberPending: mocks.projectMemberPending }));
vi.mock('@/app/automation/automationUpdate', () => ({
    emitProjectAutomationUpdate: mocks.emitProjectAutomationUpdate,
}));

import { projectRoutes } from './projectRoutes';
import { projectMemberRoutes } from './projectMemberRoutes';

async function makeApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'owner-1';
    });
    projectRoutes(typed);
    projectMemberRoutes(typed);
    await typed.ready();
    return typed;
}

const project = {
    id: 'project-1', accountId: 'owner-1', name: 'Project', description: '', color: '#fff',
    config: { machineId: 'machine-2', workspaceDir: '/workspace/two' },
    isDefault: false, createdAt: new Date(0), updatedAt: new Date(1),
};

describe('project routes follow-up invalidation updates', () => {
    let app: Fastify;
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.projectUpdate.mockResolvedValue({ ok: true, value: project });
        mocks.projectMemberUpdate.mockResolvedValue({ ok: true, value: { id: 'member-1', role: 'viewer' } });
        mocks.projectMemberRemove.mockResolvedValue({ ok: true, value: true });
    });
    afterEach(async () => { if (app) await app.close(); });

    it('fans out after a project target update', async () => {
        app = await makeApp();
        const response = await app.inject({
            method: 'POST', url: '/v1/projects/project-1',
            payload: { config: { machineId: 'machine-2', workspaceDir: '/workspace/two' } },
        });
        expect(response.statusCode).toBe(200);
        expect(mocks.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-1', { projectId: 'project-1', reason: 'sync' }, 'owner-1',
        );
    });

    it.each([
        ['role downgrade', 'POST', '/v1/projects/project-1/members/member-1/role', { role: 'viewer' }],
        ['member removal', 'DELETE', '/v1/projects/project-1/members/member-1', undefined],
    ] as const)('fans out after %s', async (_case, method, url, payload) => {
        app = await makeApp();
        const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
        expect(response.statusCode).toBe(200);
        expect(mocks.emitProjectAutomationUpdate).toHaveBeenCalledWith(
            'project-1', { projectId: 'project-1', reason: 'sync' }, 'owner-1',
        );
    });
});
