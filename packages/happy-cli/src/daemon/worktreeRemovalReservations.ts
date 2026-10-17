/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary strict-followup-plan F2 (reservation).
 *
 * A removal runs in steps the browser drives: the dry run, then the preview stop, then the removal.
 * The server keeps conversations from being linked to the worktree in between; this keeps the daemon
 * from starting or resuming one inside it, whatever the server says. A dry run that found the
 * worktree removable reserves it; the removal (or the expiry, as on the server) ends the reservation.
 * It lives in memory: after a restart the server's reservation and the removal's own checks remain.
 */
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** The server's reservation lives as long (aplus-dev-studio `strictWorktreeRoutes` LOCK_TTL_MS). */
export const WORKTREE_REMOVAL_RESERVATION_MS = 15 * 60_000;

async function canonical(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

export class WorktreeRemovalReservations {
    private readonly ttlMs: number;
    private readonly until = new Map<string, number>();

    constructor(options: { ttlMs?: number } = {}) {
        this.ttlMs = options.ttlMs ?? WORKTREE_REMOVAL_RESERVATION_MS;
    }

    async reserve(path: string, now: number = Date.now()): Promise<void> {
        this.until.set(await canonical(path), now + this.ttlMs);
    }

    async release(path: string): Promise<void> {
        this.until.delete(await canonical(path));
    }

    /** Whether `directory` is a reserved worktree or inside one. */
    async covers(directory: string, now: number = Date.now()): Promise<boolean> {
        const target = await canonical(directory);
        for (const [path, until] of this.until) {
            if (until < now) {
                this.until.delete(path);
                continue;
            }
            if (target === path || target.startsWith(path + sep)) return true;
        }
        return false;
    }
}

/** The daemon's reservations, shared by the worktree operations and the session launcher. */
export const worktreeRemovalReservations = new WorktreeRemovalReservations();

/** Why a session may not start in `directory` now, or null. */
export async function spawnRefusalForRemoval(
    directory: string,
    reservations: WorktreeRemovalReservations = worktreeRemovalReservations,
): Promise<string | null> {
    return await reservations.covers(directory) ? '이 작업 트리를 정리하는 중이라 대화를 시작할 수 없습니다.' : null;
}
