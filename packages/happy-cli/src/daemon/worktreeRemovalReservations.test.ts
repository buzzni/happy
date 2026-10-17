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
        // A folder the session would create first, through the same link.
        expect(await reservations.covers(join(link, 'not-yet', 'deeper'), 2_000)).toBe(true);
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
        expect(await spawnRefusalForRemoval(join(path, 'app'), reservations)).toMatch(/정리하는 중/);
        expect(await spawnRefusalForRemoval(root, reservations)).toBeNull();
    });
});

describe('reservation window', () => {
    // A removal the browser gave up on (the preview did not stop, the tab closed) cannot tell the
    // daemon; the window is only as long as the preview stop needs, as the server's dry run hold.
    it('lasts five minutes by default', async () => {
        const { path } = worktree();
        const reservations = new WorktreeRemovalReservations();
        await reservations.reserve(path, 0);
        expect(await reservations.covers(path, 5 * 60_000)).toBe(true);
        expect(await reservations.covers(path, 5 * 60_000 + 1)).toBe(false);
    });
});

// Review (F2 #3): a conversation already running inside the worktree, or one being started there, keeps
// a non-forced removal from going ahead; the spawn check alone runs too early to see the reservation.
describe('conversations inside a worktree', () => {
    it('sees running sessions and launches in progress inside the worktree only', async () => {
        const { root, path } = worktree();
        const reservations = new WorktreeRemovalReservations();
        let live: string[] = [];
        reservations.setLiveDirectories(() => live);
        expect(await reservations.inUse(path)).toBe(false);
        live = [join(path, 'app')];
        expect(await reservations.inUse(path)).toBe(true);
        live = [root];
        expect(await reservations.inUse(path)).toBe(false);
        const done = await reservations.beginLaunch(join(path, 'app'));
        expect(await reservations.inUse(path)).toBe(true);
        done();
        expect(await reservations.inUse(path)).toBe(false);
    });
});
