import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    tx: null as any,
    invalidateSessionFollowups: vi.fn(async () => []),
    getProjectAsOwner: vi.fn(async () => ({ ok: true, value: {} })),
}));

vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback(mocks.tx) }));
vi.mock('@/app/automation/sessionFollowupInvalidationService', () => ({
    invalidateSessionFollowups: mocks.invalidateSessionFollowups,
}));
vi.mock('./projectAccessCheck', () => ({ getProjectAsOwner: mocks.getProjectAsOwner }));
vi.mock('./projectMemberList', () => ({ buildMemberInfo: (member: unknown) => member }));

import { projectMemberRemove } from './projectMemberRemove';
import { projectMemberUpdate } from './projectMemberUpdate';

describe('project member follow-up fence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const member = {
            id: 'member-1', projectId: 'project-1', accountId: 'editor-1', role: 'editor',
            status: 'accepted', account: { id: 'editor-1' },
        };
        mocks.tx = {
            projectMember: {
                findUnique: vi.fn(async () => member),
                update: vi.fn(async ({ data }: { data: object }) => ({ ...member, ...data })),
                delete: vi.fn(async () => member),
            },
        };
    });

    it('generation-fences loops before downgrading an editor to viewer', async () => {
        await projectMemberUpdate({ uid: 'owner-1' } as never, 'project-1', 'member-1', 'viewer');
        expect(mocks.invalidateSessionFollowups).toHaveBeenCalledWith(
            mocks.tx,
            { projectId: 'project-1', ownerAccountId: 'editor-1' },
            'PERMISSION_REVOKED',
        );
        expect(mocks.invalidateSessionFollowups.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.projectMember.update.mock.invocationCallOrder[0]);
    });

    it('generation-fences loops before removing the initiating member', async () => {
        await projectMemberRemove({ uid: 'owner-1' } as never, 'project-1', 'member-1');
        expect(mocks.invalidateSessionFollowups).toHaveBeenCalledWith(
            mocks.tx,
            { projectId: 'project-1', ownerAccountId: 'editor-1' },
            'PERMISSION_REVOKED',
        );
        expect(mocks.invalidateSessionFollowups.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.projectMember.delete.mock.invocationCallOrder[0]);
    });
});
