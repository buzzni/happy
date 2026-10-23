import { randomUUID } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { logger } from '@/ui/logger';
import { getProcessStartedAt, getWindowsProcessStartedAt } from '@/utils/processStartTime';

/**
 * How long a lock that records no owner must sit untouched before it is taken as
 * abandoned. Holders keep these locks for one read plus one small fsync'd write
 * (milliseconds), so ten minutes is far past any real hold, even a slow disk.
 * Only older versions leave such locks: this version publishes a lock with its
 * owner already in it. A lock that names a live owner is never taken on age.
 */
export const UNOWNED_LOCK_STALE_MS = 10 * 60_000;
// Absorbs `ps`'s whole-second start times and small clock steps.
const REUSED_PID_SLACK_MS = 2_000;
// Each level is a guard for a guard whose reclaimer itself died; three is already a triple fault.
const MAX_GUARD_DEPTH = 3;
const ACQUIRE_ATTEMPTS = 3;
const SELF_STARTED_AT = Math.round(Date.now() - process.uptime() * 1_000);

/** The lock is held by someone it is not safe to take it from. */
export class FileLockHeldError extends Error {
    constructor(readonly holder: 'live' | 'unverified' | 'recent-unowned' | 'contended') {
        super(`file lock is held (${holder})`);
        this.name = 'FileLockHeldError';
    }
}

export interface OwnedFileLockDeps {
    isAlive?: (pid: number) => boolean;
    getProcessStartedAt?: (pid: number) => number | undefined | Promise<number | undefined>;
    now?: () => number;
    log?: (message: string) => void;
    /** Test seam: runs after a contender has judged a lock abandoned, before it reclaims. */
    onStaleJudged?: () => Promise<void>;
    /** Test seam: runs once the lock is published at its path, before acquiring returns. */
    onLockCreated?: () => Promise<void>;
    /** Test seam: runs inside the reclaim guard once the judged lock is confirmed unchanged, before it is removed. */
    onReclaimConfirmed?: () => Promise<void>;
    /** Test seam: runs once the lock is held, before `work`. */
    onAcquired?: () => Promise<void>;
}

interface LockOwner { version: 1; pid: number; startedAt: number; token: string; acquiredAt: number }
interface LockSnapshot { raw: string; owner: LockOwner | null; ino: number; mtimeMs: number }
type Verdict = { stale: true; why: 'owner-exited' | 'pid-reused' | 'unowned-abandoned' } | { stale: false; holder: FileLockHeldError['holder'] };

/**
 * Runs `work` holding an exclusive lock file shared across processes on this machine.
 *
 * The file records the owner's pid and process start time. A lock whose owner has
 * provably exited (or whose pid now belongs to a later process) is reclaimed;
 * a live owner's lock is never taken, so the caller gets a FileLockHeldError.
 * A lock is published with its owner already recorded (written aside, then
 * hard-linked into place, which fails if the path exists), so no window exists in
 * which a held lock looks ownerless and could be reclaimed from under its holder.
 * Reclaiming goes through a guard named after the exact lock instance judged
 * abandoned, itself such a lock, so two contenders cannot both remove a lock and
 * then both create one.
 */
export async function withOwnedFileLock<T>(path: string, work: () => Promise<T>, deps: OwnedFileLockDeps = {}): Promise<T> {
    const held = await acquire(path, 0, deps);
    try {
        await deps.onAcquired?.();
        return await work();
    } finally {
        await release(path, held, deps);
    }
}

async function acquire(path: string, depth: number, deps: OwnedFileLockDeps): Promise<LockOwner> {
    const now = deps.now ?? Date.now;
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
        const owner: LockOwner = { version: 1, pid: process.pid, startedAt: SELF_STARTED_AT, token: randomUUID(), acquiredAt: now() };
        if (await publish(path, owner)) {
            await deps.onLockCreated?.();
            return owner;
        }
        const seen = await inspect(path);
        if (!seen) continue; // Released meanwhile.
        const verdict = await judge(seen, deps);
        if (!verdict.stale) throw new FileLockHeldError(verdict.holder);
        await deps.onStaleJudged?.();
        if (await reclaim(path, seen, depth, deps)) {
            (deps.log ?? logDebug)(`[owned-file-lock] reclaimed ${path} (${verdict.why}; owner pid=${seen.owner?.pid ?? 'unknown'})`);
        }
    }
    throw new FileLockHeldError('contended');
}

/** Puts a lock that already names its owner at `path`; false if one is there. */
async function publish(path: string, owner: LockOwner): Promise<boolean> {
    const pending = `${path}.${owner.token}.pending`;
    await writeFile(pending, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    try {
        await link(pending, path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
    } finally {
        await unlink(pending).catch(() => {});
    }
}

/** Removes the judged instance only, and only while holding that instance's guard. */
async function reclaim(path: string, judged: LockSnapshot, depth: number, deps: OwnedFileLockDeps): Promise<boolean> {
    if (depth >= MAX_GUARD_DEPTH) return false;
    const guardPath = `${path}.reclaim-${instanceKey(judged)}`;
    let guard: LockOwner;
    try {
        guard = await acquire(guardPath, depth + 1, deps);
    } catch (error) {
        if (error instanceof FileLockHeldError) return false;
        throw error;
    }
    try {
        const current = await inspect(path);
        if (!current || instanceKey(current) !== instanceKey(judged)) return false; // Someone else got there first.
        await deps.onReclaimConfirmed?.();
        await unlink(path);
        return true;
    } finally {
        await release(guardPath, guard, deps);
    }
}

async function release(path: string, held: LockOwner, deps: OwnedFileLockDeps): Promise<void> {
    const current = await inspect(path).catch(() => null);
    // Never delete a lock that is no longer ours; its new holder is still working.
    if (current?.owner?.token !== held.token) {
        (deps.log ?? logDebug)(`[owned-file-lock] ${path} was no longer ours at release; left in place`);
        return;
    }
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
        (deps.log ?? logDebug)(`[owned-file-lock] could not remove ${path}: ${error.code ?? 'error'}`);
    });
}

async function judge(seen: LockSnapshot, deps: OwnedFileLockDeps): Promise<Verdict> {
    const { owner } = seen;
    if (!owner) {
        const abandoned = (deps.now ?? Date.now)() - seen.mtimeMs > UNOWNED_LOCK_STALE_MS;
        return abandoned ? { stale: true, why: 'unowned-abandoned' } : { stale: false, holder: 'recent-unowned' };
    }
    let startedAt: number | undefined;
    if (owner.pid === process.pid) {
        startedAt = SELF_STARTED_AT;
    } else {
        if (!(deps.isAlive ?? isAlive)(owner.pid)) return { stale: true, why: 'owner-exited' };
        const lookup = deps.getProcessStartedAt ?? (process.platform === 'win32' ? getWindowsProcessStartedAt : getProcessStartedAt);
        startedAt = await lookup(owner.pid);
    }
    // A live owner may just be stalled; only proof that it is gone frees its lock.
    if (startedAt === undefined) return { stale: false, holder: 'unverified' };
    // A holder starts before it takes the lock, so a process that started after
    // the lock was taken has inherited the pid. Measured against acquiredAt, the
    // same wall clock `ps` reports, not the recorded start: that one comes from
    // process.uptime(), which on macOS stops while the machine sleeps.
    return startedAt > owner.acquiredAt + REUSED_PID_SLACK_MS ? { stale: true, why: 'pid-reused' } : { stale: false, holder: 'live' };
}

async function inspect(path: string): Promise<LockSnapshot | null> {
    try {
        const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        return { raw, owner: parseOwner(raw), ino: info.ino, mtimeMs: info.mtimeMs };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/** Unique per lock instance: owners carry a random token; ownerless files fall back to inode and mtime. */
function instanceKey(seen: LockSnapshot): string {
    return seen.owner ? seen.owner.token : `u${seen.ino}-${Math.trunc(seen.mtimeMs)}`;
}

function parseOwner(raw: string): LockOwner | null {
    try {
        const value = JSON.parse(raw) as Partial<LockOwner>;
        if (value.version === 1 && Number.isSafeInteger(value.pid) && value.pid! > 0 && Number.isSafeInteger(value.startedAt)
            && Number.isSafeInteger(value.acquiredAt) && typeof value.token === 'string' && /^[0-9a-f-]{36}$/.test(value.token)) {
            return value as LockOwner;
        }
    } catch {
        // Written by an older version, which records no owner.
    }
    return null;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // Only ESRCH proves absence; EPERM is a live process of another account.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

function logDebug(message: string): void {
    logger.debug(message);
}
