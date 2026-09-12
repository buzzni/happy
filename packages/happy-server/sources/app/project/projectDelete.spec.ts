import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        project: {
            findUnique: vi.fn(),
            delete: vi.fn(async () => ({})),
        },
        automation: { findMany: vi.fn() },
        automationChange: { createMany: vi.fn(async () => ({ count: 1 })) },
        sessionFollowup: { findMany: vi.fn() },
        sessionFollowupChange: { createMany: vi.fn(async () => ({ count: 1 })) },
    };
    return { tx };
});

vi.mock('@/storage/db', () => ({ db: mocks.tx }));
vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback(mocks.tx) }));

import { Context } from '@/context';
import { projectDelete } from './projectDelete';

describe('projectDelete automation lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tx.project.findUnique.mockResolvedValue({ id: 'project-1', accountId: 'owner-1', isDefault: false });
        mocks.tx.automation.findMany.mockResolvedValue([{
            id: 'automation-1', revision: 4, generation: 7,
            machineAccountId: 'owner-1', machineId: 'machine-1',
        }]);
        mocks.tx.sessionFollowup.findMany.mockResolvedValue([{
            id: 'followup-1', revision: 6, generation: 9,
            machineAccountId: 'owner-1', machineId: 'machine-1',
        }]);
    });

    it('appends durable tombstones before cascading project automations', async () => {
        await expect(projectDelete(Context.create('owner-1'), 'project-1'))
            .resolves.toEqual({ ok: true, value: true });

        expect(mocks.tx.automationChange.createMany).toHaveBeenCalledWith({
            data: [{
                automationId: 'automation-1', revision: 5, generation: 8,
                machineAccountId: 'owner-1', machineId: 'machine-1', kind: 'TOMBSTONE',
            }],
        });
        expect(mocks.tx.automationChange.createMany.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.project.delete.mock.invocationCallOrder[0]!);
        expect(mocks.tx.sessionFollowupChange.createMany).toHaveBeenCalledWith({
            data: [{
                followupId: 'followup-1', revision: 7, generation: 10,
                machineAccountId: 'owner-1', machineId: 'machine-1', kind: 'TOMBSTONE',
            }],
        });
        expect(mocks.tx.sessionFollowupChange.createMany.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.project.delete.mock.invocationCallOrder[0]!);
    });
});
