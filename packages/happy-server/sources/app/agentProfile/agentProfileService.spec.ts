import { describe, expect, it, vi } from 'vitest';
import {
    createAgentProfile,
    deleteAgentProfile,
    listAgentProfiles,
    updateAgentProfile,
} from './agentProfileService';

function profile(overrides: Record<string, unknown> = {}) {
    return {
        id: 'profile-1',
        accountId: 'account-1',
        name: '기본 작업',
        agent: 'codex',
        model: 'default',
        worktreeEnabled: true,
        active: true,
        createdAt: new Date('2026-08-13T00:00:00Z'),
        updatedAt: new Date('2026-08-13T00:00:00Z'),
        ...overrides,
    };
}

describe('agentProfileService', () => {
    it('lists only the authenticated account profiles with the active profile first', async () => {
        const findMany = vi.fn().mockResolvedValue([profile()]);
        const tx = { agentLaunchProfile: { findMany } } as any;

        const result = await listAgentProfiles(tx, 'account-1');

        expect(result).toEqual([profile()]);
        expect(findMany).toHaveBeenCalledWith({
            where: { accountId: 'account-1' },
            orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
        });
    });

    it('deactivates the previous profile before creating an active profile', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const create = vi.fn().mockResolvedValue(profile());
        const tx = { agentLaunchProfile: { updateMany, create } } as any;

        const result = await createAgentProfile(tx, 'account-1', {
            name: '기본 작업', agent: 'codex', model: 'default', worktreeEnabled: true,
        });

        expect(updateMany).toHaveBeenCalledWith({
            where: { accountId: 'account-1', active: true },
            data: { active: false },
        });
        expect(create).toHaveBeenCalledWith({ data: {
            accountId: 'account-1',
            name: '기본 작업',
            agent: 'codex',
            model: 'default',
            worktreeEnabled: true,
            active: true,
        } });
        expect(result.active).toBe(true);
    });

    it('cannot update another account profile', async () => {
        const findFirst = vi.fn().mockResolvedValue(null);
        const update = vi.fn();
        const tx = { agentLaunchProfile: { findFirst, update } } as any;

        const result = await updateAgentProfile(tx, 'account-1', 'profile-2', { name: '침범' });

        expect(result).toEqual({ ok: false, error: 'not-found' });
        expect(findFirst).toHaveBeenCalledWith({ where: { id: 'profile-2', accountId: 'account-1' } });
        expect(update).not.toHaveBeenCalled();
    });

    it('honors an explicit request to deactivate the current profile', async () => {
        const current = profile();
        const updateMany = vi.fn();
        const update = vi.fn().mockResolvedValue({ ...current, active: false });
        const tx = { agentLaunchProfile: {
            findFirst: vi.fn().mockResolvedValue(current),
            updateMany,
            update,
        } } as any;

        const result = await updateAgentProfile(tx, 'account-1', 'profile-1', { activate: false });

        expect(updateMany).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledWith({
            where: { id: 'profile-1' },
            data: { active: false },
        });
        expect(result).toEqual({ ok: true, value: { ...current, active: false } });
    });

    it('activates the most recently updated remaining profile after deleting the active profile', async () => {
        const current = profile();
        const fallback = profile({ id: 'profile-2', active: false });
        const tx = { agentLaunchProfile: {
            findFirst: vi.fn()
                .mockResolvedValueOnce(current)
                .mockResolvedValueOnce(fallback),
            delete: vi.fn().mockResolvedValue(current),
            update: vi.fn().mockResolvedValue({ ...fallback, active: true }),
        } } as any;

        const result = await deleteAgentProfile(tx, 'account-1', 'profile-1');

        expect(result).toEqual({ ok: true, activeProfile: { ...fallback, active: true } });
        expect(tx.agentLaunchProfile.findFirst).toHaveBeenNthCalledWith(2, {
            where: { accountId: 'account-1' },
            orderBy: { updatedAt: 'desc' },
        });
        expect(tx.agentLaunchProfile.update).toHaveBeenCalledWith({
            where: { id: 'profile-2' }, data: { active: true },
        });
    });
});
