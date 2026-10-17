import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLockHeldError, UNOWNED_LOCK_STALE_MS, withOwnedFileLock, type OwnedFileLockDeps } from './ownedFileLock';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function lockPath() {
    const dir = await mkdtemp(join(tmpdir(), 'owned-lock-')); dirs.push(dir);
    return join(dir, 'store.json.lock');
}

/** A pid that certainly belonged to a process which has exited. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise(resolve => child.once('exit', resolve));
    return child.pid!;
}

const owner = (pid: number, startedAt = 1_000, token = '11111111-1111-4111-8111-111111111111') =>
    JSON.stringify({ version: 1, pid, startedAt, token, acquiredAt: startedAt });

function quiet(extra: OwnedFileLockDeps = {}) {
    const logs: string[] = [];
    return { logs, deps: { log: (message: string) => { logs.push(message); }, ...extra } satisfies OwnedFileLockDeps };
}

describe('withOwnedFileLock', () => {
    it('records who holds the lock and removes it afterwards', async () => {
        const path = await lockPath();
        const seen = await withOwnedFileLock(path, async () => JSON.parse(await readFile(path, 'utf8')));
        expect(seen).toMatchObject({ version: 1, pid: process.pid });
        expect(Number.isSafeInteger(seen.startedAt)).toBe(true);
        expect(seen.token).toMatch(/^[0-9a-f-]{36}$/);
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('leaves a live holder alone', async () => {
        const path = await lockPath();
        await withOwnedFileLock(path, async () => {
            const { deps } = quiet();
            await expect(withOwnedFileLock(path, async () => 'second', deps)).rejects.toMatchObject({ holder: 'live' });
            expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(process.pid);
        });
    });

    it('reclaims the lock of an owner that has exited and logs it', async () => {
        const path = await lockPath();
        await writeFile(path, owner(await deadPid()));
        const { deps, logs } = quiet();
        expect(await withOwnedFileLock(path, async () => 'ran', deps)).toBe('ran');
        expect(logs.join('\n')).toMatch(/reclaimed .*store\.json\.lock.*owner-exited/);
        expect(await readdir(join(path, '..'))).toEqual([]);
    });

    it('reclaims a lock whose pid now belongs to a process that started later', async () => {
        const path = await lockPath();
        await writeFile(path, owner(4242, 1_000));
        const { deps, logs } = quiet({ isAlive: () => true, getProcessStartedAt: () => 1_000 + 60_000 });
        expect(await withOwnedFileLock(path, async () => 'ran', deps)).toBe('ran');
        expect(logs.join('\n')).toMatch(/pid-reused/);
    });

    it('reclaims a lock an earlier process with this same pid left behind', async () => {
        const path = await lockPath();
        await writeFile(path, owner(process.pid, 1_000));
        const { deps, logs } = quiet();
        expect(await withOwnedFileLock(path, async () => 'ran', deps)).toBe('ran');
        expect(logs.join('\n')).toMatch(/pid-reused/);
    });

    it('keeps a lock whose owner is alive with the recorded start time', async () => {
        const path = await lockPath();
        await writeFile(path, owner(4242, 1_000));
        const { deps } = quiet({ isAlive: () => true, getProcessStartedAt: () => 1_000 });
        await expect(withOwnedFileLock(path, async () => 'ran', deps)).rejects.toMatchObject({ holder: 'live' });
        expect(await readFile(path, 'utf8')).toBe(owner(4242, 1_000));
        // Its own recorded start can run late (uptime pauses during sleep); the real start is earlier still.
        const late = quiet({ isAlive: () => true, getProcessStartedAt: () => 1_000 - 3_600_000 }).deps;
        await expect(withOwnedFileLock(path, async () => 'ran', late)).rejects.toMatchObject({ holder: 'live' });
    });

    it('keeps a live pid it cannot verify until the lock is long abandoned', async () => {
        const path = await lockPath();
        await writeFile(path, owner(4242));
        const { deps } = quiet({ isAlive: () => true, getProcessStartedAt: () => undefined });
        await expect(withOwnedFileLock(path, async () => 'ran', deps)).rejects.toMatchObject({ holder: 'unverified' });
        const old = new Date(Date.now() - UNOWNED_LOCK_STALE_MS - 60_000);
        await utimes(path, old, old);
        expect(await withOwnedFileLock(path, async () => 'ran', deps)).toBe('ran');
    });

    it('treats an ownerless (older version) lock as busy until it is ten minutes old', async () => {
        const path = await lockPath();
        await writeFile(path, '');
        const { deps, logs } = quiet();
        await expect(withOwnedFileLock(path, async () => 'ran', deps)).rejects.toMatchObject({ holder: 'recent-unowned' });
        const old = new Date(Date.now() - UNOWNED_LOCK_STALE_MS - 60_000);
        await utimes(path, old, old);
        expect(await withOwnedFileLock(path, async () => 'ran', deps)).toBe('ran');
        expect(logs.join('\n')).toMatch(/unowned-abandoned/);
    });

    it('does not remove a lock that another holder owns by the time it releases', async () => {
        const path = await lockPath();
        const other = owner(4242);
        await withOwnedFileLock(path, async () => { await writeFile(path, other); }, quiet().deps);
        expect(await readFile(path, 'utf8')).toBe(other);
    });

    it('lets exactly one contender in when several reclaim the same dead lock at once', async () => {
        const path = await lockPath();
        const counter = join(path, '..', 'counter');
        await writeFile(counter, '0');
        await writeFile(path, owner(await deadPid()));
        const contenders = 6;
        // Barrier 1: every contender judges the same dead lock stale before anyone reclaims.
        // Barrier 2: only the first goes on; the rest act on that stale judgment once it already
        // holds the fresh lock — the moment a careless reclaim would delete the live holder's lock.
        let judged = 0; let openJudged!: () => void; let openEntered!: () => void;
        const allJudged = new Promise<void>(resolve => { openJudged = resolve; });
        const entered = new Promise<void>(resolve => { openEntered = resolve; });
        const deps: OwnedFileLockDeps = {
            log: () => {},
            onStaleJudged: async () => {
                const turn = ++judged;
                if (turn === contenders) openJudged();
                await allJudged;
                if (turn !== 1) await entered;
            },
        };
        let inside = 0; let maxInside = 0; let progressed = 0; let first = true;
        const othersDone = () => new Promise<void>(resolve => {
            const poll = () => progressed >= contenders - 1 ? resolve() : setTimeout(poll, 5);
            poll();
        });
        const results = await Promise.allSettled(Array.from({ length: contenders }, () => withOwnedFileLock(path, async () => {
            inside += 1; maxInside = Math.max(maxInside, inside);
            const value = Number(await readFile(counter, 'utf8'));
            if (first) { first = false; openEntered(); await othersDone(); } else progressed += 1;
            await writeFile(counter, String(value + 1));
            inside -= 1;
        }, deps).catch((error) => { progressed += 1; throw error; })));
        const won = results.filter(r => r.status === 'fulfilled').length;
        expect(judged).toBeGreaterThanOrEqual(contenders);
        expect(maxInside).toBe(1);
        expect(won).toBeGreaterThanOrEqual(1);
        expect(Number(await readFile(counter, 'utf8'))).toBe(won);
        for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(FileLockHeldError);
        expect((await readdir(join(path, '..'))).sort()).toEqual(['counter']);
    });
});
