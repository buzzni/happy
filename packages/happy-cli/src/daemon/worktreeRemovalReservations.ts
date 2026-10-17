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
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * As long as the server holds a dry run's reservation (aplus-dev-studio `strictWorktreeRoutes`): the
 * preview stop in between takes far less. A removal the browser gave up on cannot tell the daemon,
 * so this is also how long that worktree stays closed after it.
 */
export const WORKTREE_REMOVAL_RESERVATION_MS = 5 * 60_000;

/** The real path, through links, also for a folder not created yet (its nearest existing parent's). */
async function canonical(path: string): Promise<string> {
    const absolute = resolve(path);
    const rest: string[] = [];
    let current = absolute;
    for (;;) {
        try {
            return join(await realpath(current), ...rest.reverse());
        } catch {
            const parent = dirname(current);
            if (parent === current) return absolute;
            rest.push(basename(current));
            current = parent;
        }
    }
}

export class WorktreeRemovalReservations {
    private readonly ttlMs: number;
    private readonly until = new Map<string, number>();
    private readonly launching = new Map<number, string>();
    private nextLaunch = 0;
    private liveDirectories: () => Array<string | undefined> = () => [];

    constructor(options: { ttlMs?: number } = {}) {
        this.ttlMs = options.ttlMs ?? WORKTREE_REMOVAL_RESERVATION_MS;
    }

    async reserve(path: string, now: number = Date.now()): Promise<void> {
        this.until.set(await canonical(path), now + this.ttlMs);
    }

    async release(path: string): Promise<void> {
        this.until.delete(await canonical(path));
    }

    /** Where the daemon's running sessions work (set by the daemon once its session table exists). */
    setLiveDirectories(provider: () => Array<string | undefined>): void {
        this.liveDirectories = provider;
    }

    /**
     * A session about to start in `directory`, until the returned function is called. Registered
     * before the spawn checks the reservations, as a dry run reserves before it checks `inUse`: one
     * of the two always sees the other.
     */
    async beginLaunch(directory: string): Promise<() => void> {
        const id = this.nextLaunch++;
        this.launching.set(id, await canonical(directory));
        return () => { this.launching.delete(id); };
    }

    /** Whether a running or starting session works inside `worktreePath`. */
    async inUse(worktreePath: string): Promise<boolean> {
        const root = await canonical(worktreePath);
        const inside = (dir: string) => dir === root || dir.startsWith(root + sep);
        if ([...this.launching.values()].some(inside)) return true;
        for (const dir of this.liveDirectories()) {
            if (dir && inside(await canonical(dir))) return true;
        }
        return false;
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
    return await reservations.covers(directory)
        ? '이 작업 트리를 정리하는 중이라 대화를 시작할 수 없습니다. 정리가 끝나거나 몇 분 뒤에 다시 시도하세요.'
        : null;
}
