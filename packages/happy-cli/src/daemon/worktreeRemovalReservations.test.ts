/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary strict-followup-plan F2 (reservation): from a
 * removal's dry run to the removal, no conversation starts or resumes inside that worktree.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnRefusalForRemoval, WorktreeRemovalReservations } from './worktreeRemovalReservations';

function worktree(): { root: string; path: string } {
    const root = mkdtempSync(join(tmpdir(), 'removal-reservation-'));
    const path = join(root, '.aplus', 'worktrees', 'wt-1');
    mkdirSync(join(path, 'app'), { recursive: true });
    return { root, path };
}

describe('WorktreeRemovalReservations', () => {
    it('refuses the reserved worktree and the folders inside it, and nothing else', async () => {
        const { root, path } = worktree();
        const reservations = new WorktreeRemovalReservations({ ttlMs: 60_000 });
        await reservations.reserve(path, 1_000);
        expect(await reservations.covers(path, 2_000)).toBe(true);
        expect(await reservations.covers(join(path, 'app'), 2_000)).toBe(true);
        expect(await reservations.covers(`${path}-other`, 2_000)).toBe(false);
        expect(await reservations.covers(root, 2_000)).toBe(false);
    });

    it('sees through a link into the reserved worktree', async () => {
        const { root, path } = worktree();
        const link = join(root, 'link');
        symlinkSync(path, link);
        const reservations = new WorktreeRemovalReservations({ ttlMs: 60_000 });
        await reservations.reserve(path, 1_000);
        expect(await reservations.covers(join(link, 'app'), 2_000)).toBe(true);
    });

    it('ends at the removal, or when it expires', async () => {
        const { path } = worktree();
        const reservations = new WorktreeRemovalReservations({ ttlMs: 60_000 });
        await reservations.reserve(path, 1_000);
        expect(await reservations.covers(path, 61_001)).toBe(false);
        await reservations.reserve(path, 70_000);
        await reservations.release(path);
        expect(await reservations.covers(path, 70_001)).toBe(false);
    });
});

describe('spawnRefusalForRemoval', () => {
    it('explains a launch inside a worktree being removed, and lets any other launch through', async () => {
        const { root, path } = worktree();
        const reservations = new WorktreeRemovalReservations({ ttlMs: 60_000 });
        await reservations.reserve(path);
        expect(await spawnRefusalForRemoval(join(path, 'app'), reservations)).toBe('이 작업 트리를 정리하는 중이라 대화를 시작할 수 없습니다.');
        expect(await spawnRefusalForRemoval(root, reservations)).toBeNull();
    });
});
