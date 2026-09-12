import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    tx: null as any,
    invalidateSessionFollowups: vi.fn(async () => []),
}));

vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback(mocks.tx) }));
vi.mock('@/app/automation/sessionFollowupInvalidationService', () => ({
    invalidateSessionFollowups: mocks.invalidateSessionFollowups,
}));

import { projectUpdate } from './projectUpdate';

describe('projectUpdate follow-up fence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const project = {
            id: 'project-1', accountId: 'owner-1', name: 'Project', description: '', color: '#fff',
            config: { machineId: 'machine-1', workspaceDir: '/workspace/one' },
            isDefault: false, createdAt: new Date(0), updatedAt: new Date(0),
        };
        mocks.tx = {
            project: {
                findUnique: vi.fn(async () => project),
                update: vi.fn(async ({ data }: { data: object }) => ({ ...project, ...data })),
            },
        };
    });

    it('invalidates active follow-ups in the same transaction when the execution target changes', async () => {
        await projectUpdate({ uid: 'owner-1' } as never, 'project-1', {
            config: { machineId: 'machine-2', workspaceDir: '/workspace/two' },
        });
        expect(mocks.invalidateSessionFollowups).toHaveBeenCalledWith(
            mocks.tx, { projectId: 'project-1' }, 'TARGET_MISMATCH',
        );
        expect(mocks.invalidateSessionFollowups.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.project.update.mock.invocationCallOrder[0]);
    });

    it('preserves a loop when only non-target project configuration changes', async () => {
        await projectUpdate({ uid: 'owner-1' } as never, 'project-1', {
            config: {
                machineId: 'machine-1', workspaceDir: '/workspace/one',
                environmentVariables: { SAFE: 'value' },
            },
        });
        expect(mocks.invalidateSessionFollowups).not.toHaveBeenCalled();
    });
});
