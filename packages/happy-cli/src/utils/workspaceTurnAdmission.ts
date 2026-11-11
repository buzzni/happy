import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { withOwnedFileLock, FileLockHeldError } from './ownedFileLock';
import { readCurrentBootIdSync } from './bootIdentity';
import { logger } from '@/ui/logger';

const ownerSchema = z.strictObject({
  token: z.string().uuid(), sessionId: z.string().min(1).max(200), kind: z.enum(['manual', 'manual-launch', 'automation', 'unfenced']),
  controller: z.string().uuid().optional(),
  pid: z.number().int().positive(), bootId: z.string().min(1).nullable(), acquiredAt: z.number().int().nonnegative(),
  roots: z.array(z.string().min(1).refine(isAbsolute)).min(1).max(256),
  identities: z.array(z.strictObject({ root: z.string().min(1), identity: z.string().nullable(),
    ancestors: z.array(z.string().min(1)).max(256) })).max(512).optional(),
});
const registrySchema = z.strictObject({ version: z.literal(1), owners: z.array(ownerSchema).max(512) });
type Owner = z.infer<typeof ownerSchema>;
export type WorkspaceTurnAdmissionResult = { acquired: true } | {
  acquired: false; reason: 'workspace-busy' | 'workspace-owner-unconfirmed' | 'registry-busy'; sessions: string[];
};
export type LegacyDispatchReservation = Exclude<WorkspaceTurnAdmissionResult, { acquired: true }> | {
  acquired: true; finish(): Promise<void>;
};
const MAX_REGISTRY_BYTES = 1024 * 1024;
/** Unknown descendants cannot be evicted by age or PID. At capacity, retain a broader boot-bound
 * fence instead: legacy work can proceed, while any new automatic workspace needs verification. */
function boundedOwners(owners: Owner[]): Owner[] {
  const fits = (value: Owner[]) => registrySchema.safeParse({ version: 1, owners: value }).success
    && Buffer.byteLength(JSON.stringify({ version: 1, owners: value })) <= MAX_REGISTRY_BYTES;
  const pressure = !fits(owners), groups = new Map<string | null, Owner[]>();
  for (const owner of owners) if (owner.kind === 'unfenced') {
    const group = groups.get(owner.bootId) ?? []; group.push(owner); groups.set(owner.bootId, group);
  }
  const compact = new Set([...groups].filter(([, group]) => pressure
    || group.length > 1 && group.some(owner => owner.roots.includes('/'))).map(([boot]) => boot));
  if (!compact.size) {
    if (pressure) throw new Error('WORKSPACE_ADMISSION_CAPACITY');
    return owners;
  }
  const retained = owners.filter(owner => owner.kind !== 'unfenced' || !compact.has(owner.bootId));
  for (const boot of compact) {
    const group = groups.get(boot)!;
    const original = group.find(owner => owner.roots.includes('/')) ?? group[0];
    retained.push({ ...original, roots: ['/'], identities: undefined, controller: undefined });
  }
  if (!fits(retained)) throw new Error('WORKSPACE_ADMISSION_CAPACITY');
  if (pressure) logger.warn('[workspace-admission] Unconfirmed writer capacity requires broader workspace verification');
  return retained;
}
const registryQueues = new Map<string, Promise<void>>();
const heldRegistryPaths = new AsyncLocalStorage<ReadonlySet<string>>();
/** Queue local bookkeeping; retry only foreign file-lock contention, never the callback's work.
 * Identity observation stays inside the file lock so a rename cannot invalidate its snapshot. */
async function withRegistryLock<T>(path: string, work: () => Promise<T>, retries = 25): Promise<T> {
  // An awaited admission from inside this very observation cannot queue behind itself.
  if (heldRegistryPaths.getStore()?.has(path)) throw new FileLockHeldError('contended');
  const previous = registryQueues.get(path) ?? Promise.resolve();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const next = previous.catch(() => undefined).then(() => pending);
  registryQueues.set(path, next);
  try {
    await previous.catch(() => undefined);
    for (let attempt = 0; ; attempt++) {
      let entered = false;
      try {
        return await withOwnedFileLock(path, async () => {
          entered = true;
          return heldRegistryPaths.run(new Set([...(heldRegistryPaths.getStore() ?? []), path]), work);
        });
      } catch (error) {
        if (entered || !(error instanceof FileLockHeldError) || attempt >= retries) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    finish();
    if (registryQueues.get(path) === next) registryQueues.delete(path);
  }
}
async function rootIdentities(roots: readonly string[]): Promise<NonNullable<Owner['identities']>> {
  const result: NonNullable<Owner['identities']> = [];
  for (const root of roots) {
    let directory = root, identity: string | null = null;
    const ancestors: string[] = [];
    while (true) {
      const info = await stat(directory, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info) {
        const id = `${info.dev}:${info.ino}`;
        if (directory === root) identity = id;
        ancestors.push(id);
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    result.push({ root, identity, ancestors });
  }
  return result;
}
const combineIdentities = (...groups: Array<Owner['identities']>) =>
  [...new Map(groups.flatMap(group => group ?? []).map(value => [JSON.stringify(value), value])).values()];
const identitiesOverlap = (a: Owner['identities'], b: Owner['identities']) => (a ?? []).some(left => (b ?? []).some(right =>
  left.identity !== null && right.ancestors.includes(left.identity) || right.identity !== null && left.ancestors.includes(right.identity)));
const git = promisify(execFile);
/** Resolve aliases and preserve missing target suffixes. Include Git's shared metadata directory
 * so separate linked worktrees contend for the same repository without merging unrelated siblings. */
export async function canonicalWorkspaceAdmissionRoots(roots: readonly string[], requireGitIdentity = true): Promise<string[]> {
  if (!roots.length || roots.some(root => !isAbsolute(root))) throw new Error('WORKSPACE_ADMISSION_ROOT_INVALID');
  async function canonical(path: string): Promise<{ path: string; existing: string }> {
    try {
      const actual = await realpath(path);
      if (!(await stat(actual)).isDirectory()) throw new Error('WORKSPACE_ADMISSION_ROOT_INVALID');
      return { path: actual, existing: actual };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
      const entry = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (entry) throw new Error('WORKSPACE_ADMISSION_ROOT_INVALID');
      const parent = await canonical(dirname(path));
      return { path: join(parent.path, basename(path)), existing: parent.existing };
    }
  }
  const paths: string[] = [];
  for (const root of roots) {
    const value = await canonical(resolve(root)); paths.push(value.path);
    let directory = value.existing;
    while (true) {
      const metadata = await lstat(join(directory, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (metadata) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
        try {
          const result = await git('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', value.existing,
            'rev-parse', '--git-common-dir'], { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 10000, maxBuffer: 8192, windowsHide: true });
          paths.push((await canonical(resolve(value.existing, result.stdout.trim()))).path);
          if (requireGitIdentity) {
            // The common directory also knows registered checkouts whose own .git pointer is
            // temporarily broken. Include them before admitting automation, so a legacy Git
            // repair cannot hide an unknown writer in another checkout of this repository.
            const listed = await git('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', value.existing,
              'worktree', 'list', '--porcelain', '-z'], { env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
              timeout: 10000, maxBuffer: 128 * 1024, encoding: 'buffer', windowsHide: true });
            const checkouts = new TextDecoder('utf-8', { fatal: true }).decode(listed.stdout).split('\0').filter(field => field.startsWith('worktree '));
            if (!checkouts.length) throw new Error('WORKSPACE_REPOSITORY_IDENTITY_UNCONFIRMED');
            for (const field of checkouts) {
              const checkout = field.slice('worktree '.length);
              if (!isAbsolute(checkout)) throw new Error('WORKSPACE_REPOSITORY_IDENTITY_UNCONFIRMED');
              const slot = resolve(checkout), current = (await canonical(slot)).path;
              // A missing registered slot may still have an unknown writer after rename.
              // Retargeted aliases cannot prove where its earlier writers now operate.
              if (current !== slot) throw new Error('WORKSPACE_REPOSITORY_IDENTITY_UNCONFIRMED');
              paths.push(slot);
            }
          }
        } catch (cause) {
          if (requireGitIdentity) throw new Error('WORKSPACE_REPOSITORY_IDENTITY_UNCONFIRMED', { cause });
          // A legacy command may be repairing this very repository. Preserve its declared
          // folder ownership; a new automatic run must still resolve its Git identity above.
          logger.warn('[workspace-admission] Legacy folder retained with unconfirmed Git identity');
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...new Set(paths)].sort();
}
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
  home: string; sessionId: string; kind: 'manual' | 'manual-launch' | 'automation'; roots: readonly string[];
  /** Test seam. Null is unknown, not permission to reclaim. */
  bootId?: string | null;
  /** Persist before acquiring for an automatic run. Restoring this token permits proven release, never takeover. */
  ownerToken?: string;
}) {
  const token = z.string().uuid().parse(input.ownerToken ?? randomUUID()), controller = randomUUID(), roots = [...input.roots];
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
    const data = JSON.stringify(registrySchema.parse({ version: 1, owners: boundedOwners(owners) }));
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
    return canonicalWorkspaceAdmissionRoots(roots, input.kind === 'automation');
  }
  return {
    ownerToken: token,
    async tryAcquire(): Promise<WorkspaceTurnAdmissionResult> {
      await prepare();
      try {
        return await withRegistryLock(file + '.lock', async () => {
          // Normal filesystem mutations acquire this same registry before their effect.
          // Resolve here so a completed rename cannot invalidate an earlier outside snapshot.
          const paths = await canonicalRoots();
          const identities = await rootIdentities(paths);
          const previous = await read();
          const owners = previous.filter(owner => !bootId || !owner.bootId || owner.bootId === bootId);
          const own = owners.find(owner => owner.token === token && owner.controller === controller);
          if (own) {
            if (JSON.stringify(own.roots) !== JSON.stringify(paths) || own.sessionId !== input.sessionId || own.kind !== input.kind) {
              throw new Error('WORKSPACE_ADMISSION_IDENTITY_CONFLICT');
            }
            return { acquired: true } as const;
          }
          const refusal = (entries: Owner[]): Exclude<WorkspaceTurnAdmissionResult, { acquired: true }> | null => {
            const blockers = entries.filter(owner => owner.token === token || owner.sessionId === input.sessionId ||
              (owner.kind === 'automation' || input.kind === 'automation')
                && (owner.roots.some(a => paths.some(b => overlaps(a, b))) || identitiesOverlap(owner.identities, identities)));
            if (!blockers.length) return null;
            const confirmedAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
            return { acquired: false, reason: blockers.some(owner => owner.kind === 'unfenced' || !confirmedAlive(owner.pid))
              ? 'workspace-owner-unconfirmed' : 'workspace-busy', sessions: [...new Set(blockers.map(owner => owner.sessionId))] };
          };
          const blocked = refusal(owners); if (blocked) return blocked;
          const candidate = ownerSchema.parse({ token, controller, sessionId: input.sessionId, kind: input.kind, pid: process.pid,
            bootId, roots: paths, identities, acquiredAt: Date.now() });
          const next = boundedOwners([...owners, candidate]), others = next.filter(owner => owner !== candidate);
          const widened = refusal(others);
          if (widened) { await write(others); return widened; }
          await write(next);
          return { acquired: true } as const;
        }, input.kind === 'automation' ? 0 : 25);
      } catch (error) {
        if (error instanceof FileLockHeldError || error instanceof Error && error.message === 'WORKSPACE_ADMISSION_CAPACITY') {
          return { acquired: false, reason: 'registry-busy', sessions: [] };
        }
        throw error;
      }
    },
    /** Before an untracked subprocess is submitted, atomically preserve its unknown write lifetime.
     * Completion, timeout and PID disappearance cannot remove this record. Repeated operations
     * in the same folders coalesce without consuming another controller's live reservation. */
    async retainUnconfirmed(): Promise<void> {
      if (input.kind !== 'manual-launch') throw new Error('WORKSPACE_ADMISSION_IDENTITY_CONFLICT');
      await prepare();
      await withRegistryLock(file + '.lock', async () => {
        const owners = await read(), own = owners.find(owner => owner.token === token && owner.controller === controller);
        if (!own || own.kind !== 'manual-launch' || own.sessionId !== input.sessionId) throw new Error('WORKSPACE_ADMISSION_IDENTITY_CONFLICT');
        const retained = owners.filter(owner => owner !== own);
        const same = retained.find(owner => owner.kind === 'unfenced' && owner.bootId === own.bootId && JSON.stringify(owner.roots) === JSON.stringify(own.roots));
        // Actual subprocess cwd/scopes must exist now. Missing clone targets belong to the
        // temporary pre-claim reservation until mkdir, never to an unidentified writer record.
        const observed = await rootIdentities(own.roots);
        if (observed.some(root => root.identity === null)) throw new Error('WORKSPACE_PROCESS_ROOT_UNCONFIRMED');
        const identities = combineIdentities(own.identities, observed, same?.identities);
        if (same) same.identities = identities;
        else retained.push({ ...own, identities, kind: 'unfenced', controller: undefined });
        await write(retained);
      });
    },
    /** Runtime owners need foreground AND background quiescence. A manual-launch reservation instead
     * needs proven non-submission or handoff to the tracked-session gate, which automation checks again. */
    async release(quiescent: boolean): Promise<boolean> {
      if (!quiescent) return false;
      await prepare();
      return withRegistryLock(file + '.lock', async () => {
        const owners = await read();
        const own = owners.find(owner => owner.token === token);
        if (!own) return false;
        if (own.kind === 'unfenced') return false;
        if (own.sessionId !== input.sessionId || own.kind !== input.kind) throw new Error('WORKSPACE_ADMISSION_IDENTITY_CONFLICT');
        await write(owners.filter(owner => owner.token !== token));
        return true;
      });
    },
  };
}

/** Compatibility for legacy process RPCs/scripts. Their execution semantics stay unchanged;
 * only a new automatic execution in an overlapping logical workspace must wait for verification. */
export function createUnfencedSubprocessAdmission(input: { home: string; bootId?: string | null }) {
  return async <T>(roots: readonly string[], operation: () => Promise<T>): Promise<T> => {
    const owner = createWorkspaceTurnAdmission({ ...input, sessionId: `legacy-process:${randomUUID()}`, kind: 'manual-launch', roots });
    const admitted = await owner.tryAcquire();
    if (!admitted.acquired) {
      const code = { 'workspace-busy': 'WORKSPACE_BUSY', 'workspace-owner-unconfirmed': 'WORKSPACE_OWNER_UNCONFIRMED',
        'registry-busy': 'WORKSPACE_REGISTRY_BUSY' }[admitted.reason];
      throw Object.assign(new Error(code), { code });
    }
    try { await owner.retainUnconfirmed(); }
    catch (error) { await owner.release(true); throw error; } // No subprocess was submitted.
    return operation();
  };
}

/** Host port shared by daemon and manual session RPCs. The record outlives the process call. */
export function createSubprocessWriteAdmission(input: { home: string }) {
  const admit = createUnfencedSubprocessAdmission(input);
  return (roots: readonly string[]): Promise<void> => admit(roots, async () => undefined);
}

/** Reserve before a legacy occurrence is claimed. finish is a handoff: every submitted producer
 * must already be covered by its native runtime owner or a durable unfenced subprocess record. */
export function createLegacyDispatchAdmission(input: { home: string; bootId?: string | null }) {
  return async (roots: readonly string[]): Promise<LegacyDispatchReservation> => {
    const owner = createWorkspaceTurnAdmission({ ...input, sessionId: `legacy-dispatch:${randomUUID()}`, kind: 'manual-launch', roots });
    const admitted = await owner.tryAcquire();
    if (!admitted.acquired) return admitted;
    return { acquired: true, async finish() {
      if (!await owner.release(true)) throw new Error('WORKSPACE_DISPATCH_HANDOFF_UNCONFIRMED');
    } };
  };
}

/** Only for awaited filesystem operations that close their own handles, never child processes.
 * Legacy file RPCs can follow aliases and carry no verified project identity, so their short
 * mutation lease conservatively overlaps every automatic workspace on this daemon. */
export function createFilesystemWriteAdmission(input: { home: string }) {
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const owner = createWorkspaceTurnAdmission({ home: input.home, sessionId: `file-rpc:${randomUUID()}`,
      kind: 'manual-launch', roots: ['/'] });
    const admitted = await owner.tryAcquire();
    if (!admitted.acquired) {
      const code = { 'workspace-busy': 'WORKSPACE_BUSY', 'workspace-owner-unconfirmed': 'WORKSPACE_OWNER_UNCONFIRMED',
        'registry-busy': 'WORKSPACE_REGISTRY_BUSY' }[admitted.reason];
      throw Object.assign(new Error(code), { code });
    }
    try { return await operation(); }
    finally {
      try {
        if (!await owner.release(true)) throw new Error('Filesystem ownership receipt is absent');
      } catch (cause) {
        throw Object.assign(new Error('WORKSPACE_FILESYSTEM_RELEASE_UNCONFIRMED', { cause }), { code: 'WORKSPACE_FILESYSTEM_RELEASE_UNCONFIRMED' });
      }
    }
  };
}
