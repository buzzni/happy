import {
    canonicalReclaimRepository, emptyReclaimResult, reclaimPressureNeeded, reclaimWorktreeDependencies, validateReclaimPath,
    type ReclaimDependencies, type ReclaimResult,
} from './worktreeDependencyReclaim';

// A daemon may reconnect with another ApiMachineClient; its deletion queue stays process-wide.
let tail: Promise<unknown> = Promise.resolve();
const pending = new Map<string, Promise<ReclaimResult>>();

export function createWorktreeReclaimHandler(
    allowedRoot: string,
    dependencies: ReclaimDependencies = {},
    run = reclaimWorktreeDependencies,
) {
    return async (input: unknown): Promise<ReclaimResult> => {
        try {
            if (!input || typeof input !== 'object' || !('path' in input)) throw new Error('invalid reclaim request');
            const path = await validateReclaimPath(input.path, allowedRoot);
            // Healthy machines do not even enumerate Git worktrees.
            if (!await reclaimPressureNeeded(path, dependencies)) return run(path, allowedRoot, dependencies);
            const root = await canonicalReclaimRepository(path, allowedRoot);
            const key = `${allowedRoot}\0${root}`;
            const active = pending.get(key);
            if (active) return active;
            const job = tail.catch(() => {}).then(() => run(root, allowedRoot, dependencies));
            pending.set(key, job);
            tail = job;
            try { return await job; }
            finally { if (pending.get(key) === job) pending.delete(key); }
        } catch (error) {
            return { ...emptyReclaimResult(), errors: [error instanceof Error ? error.message : String(error)] };
        }
    };
}
