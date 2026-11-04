import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withOwnedFileLock, FileLockHeldError } from './ownedFileLock';
import { readCurrentBootIdSync } from './bootIdentity';

const ownerSchema = z.strictObject({
  token: z.string().uuid(), sessionId: z.string().min(1).max(200), kind: z.enum(['manual', 'automation']),
  pid: z.number().int().positive(), bootId: z.string().min(1).nullable(), acquiredAt: z.number().int().nonnegative(),
  roots: z.array(z.string().min(1).refine(isAbsolute)).min(1).max(256),
});
const registrySchema = z.strictObject({ version: z.literal(1), owners: z.array(ownerSchema).max(512) });
type Owner = z.infer<typeof ownerSchema>;
export type WorkspaceTurnAdmissionResult = { acquired: true } | {
  acquired: false; reason: 'workspace-busy' | 'workspace-owner-unconfirmed' | 'registry-busy'; sessions: string[];
};
const MAX_REGISTRY_BYTES = 1024 * 1024;
const overlaps = (a: string, b: string) => {
  const contains = (root: string, child: string) => {
    const path = relative(root, child);
    return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
  };
  return contains(a, b) || contains(b, a);
};

/**
 * Cooperative foreground/background ownership, not filesystem sandboxing. The short lock protects
 * registry mutation only. Persistent owners are never reclaimed on PID exit or elapsed time: a
 * descendant may still write. Only the originating controller's quiescence proof or another kernel
 * boot can release one. Hosts must leave uncertain ownership visible and keep pending inputs queued.
 */
export function createWorkspaceTurnAdmission(input: {
  home: string; sessionId: string; kind: 'manual' | 'automation'; roots: readonly string[];
  /** Test seam. Null is unknown, not permission to reclaim. */
  bootId?: string | null;
}) {
  const token = randomUUID(), roots = [...input.roots];
  const bootId = input.bootId === undefined ? readCurrentBootIdSync() ?? null : input.bootId;
  const directory = join(input.home, 'workspace-turn-admission.v1'), file = join(directory, 'owners.json');
  async function prepare() {
    // Existing Windows runtimes retain their previous path; they must not advertise this capability.
    if (process.platform === 'win32') throw new Error('WORKSPACE_TURN_ADMISSION_UNSUPPORTED');
    if (!isAbsolute(input.home)) throw new Error('WORKSPACE_ADMISSION_HOME_UNSAFE');
    const home = await lstat(input.home);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || (home.mode & 0o022)) {
      throw new Error('WORKSPACE_ADMISSION_HOME_UNSAFE');
    }
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
      throw new Error('WORKSPACE_ADMISSION_DIRECTORY_UNSAFE');
    }
  }
  async function read(): Promise<Owner[]> {
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600
        || info.size > MAX_REGISTRY_BYTES) throw new Error('WORKSPACE_ADMISSION_REGISTRY_UNSAFE');
      const state = registrySchema.parse(JSON.parse(await handle.readFile('utf8')));
      if (new Set(state.owners.map(owner => owner.token)).size !== state.owners.length) throw new Error('WORKSPACE_ADMISSION_REGISTRY_INVALID');
      return state.owners;
    } finally { await handle.close(); }
  }
  async function write(owners: Owner[]) {
    const data = JSON.stringify(registrySchema.parse({ version: 1, owners }));
    if (Buffer.byteLength(data) > MAX_REGISTRY_BYTES) throw new Error('WORKSPACE_ADMISSION_CAPACITY');
    const temporary = file + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data); await handle.sync(); await handle.close();
      await rename(temporary, file);
      for (const path of [directory, input.home]) {
        const parent = await open(path, constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function canonicalRoots() {
    if (!roots.length || roots.some(root => !isAbsolute(root))) throw new Error('WORKSPACE_ADMISSION_ROOT_INVALID');
    const paths = [...new Set(await Promise.all(roots.map(root => realpath(root))))].sort();
    for (const root of paths) if (!(await stat(root)).isDirectory()) throw new Error('WORKSPACE_ADMISSION_ROOT_INVALID');
    return paths;
  }
  return {
    async tryAcquire(): Promise<WorkspaceTurnAdmissionResult> {
      await prepare();
      const paths = await canonicalRoots();
      try {
        return await withOwnedFileLock(file + '.lock', async () => {
          const previous = await read();
          const owners = previous.filter(owner => !bootId || !owner.bootId || owner.bootId === bootId);
          const own = owners.find(owner => owner.token === token);
          if (own) {
            if (JSON.stringify(own.roots) !== JSON.stringify(paths) || own.sessionId !== input.sessionId || own.kind !== input.kind) {
              throw new Error('WORKSPACE_ADMISSION_IDENTITY_CONFLICT');
            }
            return { acquired: true } as const;
          }
          const blockers = owners.filter(owner => owner.sessionId === input.sessionId ||
            (owner.kind === 'automation' || input.kind === 'automation') && owner.roots.some(a => paths.some(b => overlaps(a, b))));
          if (blockers.length) {
            const confirmedAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
            return { acquired: false, reason: blockers.some(owner => !confirmedAlive(owner.pid))
              ? 'workspace-owner-unconfirmed' : 'workspace-busy', sessions: [...new Set(blockers.map(owner => owner.sessionId))] } as const;
          }
          owners.push(ownerSchema.parse({ token, sessionId: input.sessionId, kind: input.kind, pid: process.pid,
            bootId, roots: paths, acquiredAt: Date.now() }));
          await write(owners);
          return { acquired: true } as const;
        });
      } catch (error) {
        if (error instanceof FileLockHeldError) return { acquired: false, reason: 'registry-busy', sessions: [] };
        throw error;
      }
    },
    /** False retains ownership. Only provider-owned foreground AND background observations may pass true. */
    async release(quiescent: boolean): Promise<boolean> {
      if (!quiescent) return false;
      await prepare();
      return withOwnedFileLock(file + '.lock', async () => {
        const owners = await read();
        if (!owners.some(owner => owner.token === token)) return false;
        await write(owners.filter(owner => owner.token !== token));
        return true;
      });
    },
  };
}
