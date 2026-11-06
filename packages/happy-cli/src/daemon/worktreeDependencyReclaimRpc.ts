import {
    canonicalReclaimRepository, emptyReclaimResult, reclaimPressureNeeded, reclaimWorktreeDependencies, validateReclaimPath,
    type ReclaimDependencies, type ReclaimResult,
} from './worktreeDependencyReclaim';
import { rm } from 'node:fs/promises';

// A daemon may reconnect with another ApiMachineClient; its deletion queue stays process-wide.
let tail: Promise<unknown> = Promise.resolve();
const pending = new Map<string, Promise<ReclaimResult>>();

export function createWorktreeReclaimHandler(
    allowedRoot: string,
    dependencies: ReclaimDependencies = {},
    run = reclaimWorktreeDependencies,
    withFilesystemMutation?: <T>(operation: () => Promise<T>) => Promise<T>,
) {
    const remove = dependencies.remove ?? ((path: string) => rm(path, { recursive: true }));
    const guardedDependencies: ReclaimDependencies = withFilesystemMutation
        ? { ...dependencies, remove: path => withFilesystemMutation(() => remove(path)) } : dependencies;
    return async (input: unknown): Promise<ReclaimResult> => {
        try {
            if (!input || typeof input !== 'object' || !('path' in input)) throw new Error('invalid reclaim request');
            const path = await validateReclaimPath(input.path, allowedRoot);
            // Healthy machines do not even enumerate Git worktrees.
            if (!await reclaimPressureNeeded(path, dependencies)) return run(path, allowedRoot, guardedDependencies);
            const root = await canonicalReclaimRepository(path, allowedRoot);
            const key = `${allowedRoot}\0${root}`;
            const active = pending.get(key);
            if (active) return active;
            const job = tail.catch(() => {}).then(() => run(root, allowedRoot, guardedDependencies));
            pending.set(key, job);
            tail = job;
            try { return await job; }
            finally { if (pending.get(key) === job) pending.delete(key); }
        } catch (error) {
            return { ...emptyReclaimResult(), errors: [error instanceof Error ? error.message : String(error)] };
        }
    };
}
