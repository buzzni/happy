import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createWorkspaceTurnAdmission } from './workspaceTurnAdmission';
import * as module from './workspaceTurnAdmission';
import { readCurrentBootIdSync } from './bootIdentity';
import { FileLockHeldError, withOwnedFileLock } from './ownedFileLock';

const statHook = vi.hoisted(() => ({ observe: undefined as undefined | ((path: string, bigint: boolean) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    const info = await actual.stat(...args);
    await statHook.observe?.(String(args[0]), Boolean((args[1] as { bigint?: boolean })?.bigint));
    return info;
  } };
});

const test = it.skipIf(process.platform === 'win32');
const fixtureBoot = readCurrentBootIdSync() ?? 'boot-A';
let home: string, workspace: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workspace-turn-admission-'));
  workspace = join(home, 'project'); await mkdir(join(workspace, 'child'), { recursive: true });
});
afterEach(async () => { statHook.observe = undefined; await rm(home, { recursive: true, force: true }); });
const admission = (sessionId: string, kind: 'manual' | 'automation', roots = [workspace], bootId = fixtureBoot) =>
  createWorkspaceTurnAdmission({ home, sessionId, kind, roots, bootId });

test('holds automation behind active manual work without consuming the manual owner', async () => {
  const manual = admission('manual', 'manual'), auto = admission('automation-run:r1', 'automation');
  expect(await manual.tryAcquire()).toEqual({ acquired: true });
  expect(await auto.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-busy', sessions: ['manual'] });
  expect(await manual.release(false)).toBe(false);
  expect((await auto.tryAcquire()).acquired).toBe(false);
  expect(await manual.release(true)).toBe(true);
  expect(await auto.tryAcquire()).toEqual({ acquired: true });
});

test('keeps manual input waiting while an automatic owner still has background writers', async () => {
  const auto = admission('automation-run:r1', 'automation'), manual = admission('manual', 'manual');
  expect((await auto.tryAcquire()).acquired).toBe(true);
  expect(await auto.release(false)).toBe(false);
  expect((await manual.tryAcquire()).acquired).toBe(false);
  expect(await auto.release(true)).toBe(true);
  expect((await manual.tryAcquire()).acquired).toBe(true);
});

test('preserves existing concurrent manual behavior and isolates unrelated workspaces', async () => {
  expect((await admission('manual-A', 'manual').tryAcquire()).acquired).toBe(true);
  expect((await admission('manual-B', 'manual').tryAcquire()).acquired).toBe(true);
  const other = join(home, 'other'); await mkdir(other);
  expect((await admission('automation-run:r1', 'automation', [other]).tryAcquire()).acquired).toBe(true);
});

test('serializes concurrent manual bookkeeping without rejecting compatible work or losing proven releases', async () => {
  const owners = Array.from({ length: 5 }, (_, index) => admission(`manual-concurrent-${index}`, 'manual'));
  expect(await Promise.all(owners.map(owner => owner.tryAcquire()))).toEqual(owners.map(() => ({ acquired: true })));
  expect(await Promise.allSettled(owners.map(owner => owner.release(true))))
    .toEqual(owners.map(() => ({ status: 'fulfilled', value: true })));
  expect(await admission('automation-run:after-manual-concurrent', 'automation').tryAcquire()).toEqual({ acquired: true });
});

test('retains concurrent legacy writers once each despite contended registry bookkeeping', async () => {
  const operation = vi.fn(async () => 'submitted');
  const execute = module.createUnfencedSubprocessAdmission({ home, bootId: fixtureBoot });
  expect(await Promise.allSettled(Array.from({ length: 5 }, () => execute([workspace], operation))))
    .toEqual(Array.from({ length: 5 }, () => ({ status: 'fulfilled', value: 'submitted' })));
  expect(operation).toHaveBeenCalledTimes(5);
  expect(await admission('automation-run:after-concurrent-legacy', 'automation').tryAcquire())
    .toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
});

test('keeps a live registry lock owned and bounds manual waiting without delaying automatic admission', async () => {
  const directory = join(home, 'workspace-turn-admission.v1'); await mkdir(directory, { mode: 0o700 });
  const manual = admission('manual-lock-held', 'manual');
  await withOwnedFileLock(join(directory, 'owners.json.lock'), async () => {
    expect(await admission('automation-run:lock-held', 'automation').tryAcquire())
      .toMatchObject({ acquired: false, reason: 'registry-busy' });
    expect(await manual.tryAcquire()).toMatchObject({ acquired: false, reason: 'registry-busy' });
  });
  expect(await manual.tryAcquire()).toEqual({ acquired: true });
  expect(await manual.release(true)).toBe(true);
});

test('never repeats registry work after its callback has started', async () => {
  const actual = await realpath(workspace);
  let calls = 0;
  statHook.observe = async (path, bigint) => {
    if (path === actual && bigint) { calls++; throw new FileLockHeldError('contended'); }
  };
  expect(await admission('manual-entered-work', 'manual').tryAcquire()).toMatchObject({ acquired: false, reason: 'registry-busy' });
  expect(calls).toBe(1);
  statHook.observe = undefined;
  expect(await admission('automation-run:after-entered-work', 'automation').tryAcquire()).toEqual({ acquired: true });
});

test('compares parent, child, additional roots and aliases by their canonical directory', async () => {
  const alias = join(home, 'alias'); await symlink(workspace, alias);
  const other = join(home, 'other'); await mkdir(other);
  expect((await admission('manual', 'manual', [other, join(workspace, 'child')]).tryAcquire()).acquired).toBe(true);
  expect((await admission('automation-run:r1', 'automation', [alias]).tryAcquire()).acquired).toBe(false);
});

test('cannot replace another controller ownership even with the same session id or an old timestamp', async () => {
  const owner = admission('automation-run:r1', 'automation'); await owner.tryAcquire();
  const file = join(home, 'workspace-turn-admission.v1', 'owners.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.owners[0].acquiredAt = 0;
  state.owners[0].pid = 2_147_483_647;
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  const restarted = admission('automation-run:r1', 'automation');
  expect(await restarted.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
  expect(await restarted.release(true)).toBe(false);
  expect((await admission('manual', 'manual').tryAcquire()).acquired).toBe(false);
  // The original controller retains its unforgeable local release authority.
  expect(await owner.release(true)).toBe(true);
});

test('reclaims only records that provably belong to another kernel boot', async () => {
  await admission('manual', 'manual').tryAcquire();
  expect((await admission('automation-run:r1', 'automation', [workspace], 'boot-B').tryAcquire()).acquired).toBe(true);
});

test('does not infer a reboot when either boot identity is unavailable', async () => {
  await admission('automation-run:r1', 'automation').tryAcquire();
  const contender = createWorkspaceTurnAdmission({ home, sessionId: 'manual', kind: 'manual', roots: [workspace], bootId: null });
  expect((await contender.tryAcquire()).acquired).toBe(false);
});

test('serializes independent controllers racing for the same workspace', async () => {
  const controllers = [admission('automation-run:r1', 'automation'), admission('automation-run:r2', 'automation')];
  const results = await Promise.all(controllers.map(c => c.tryAcquire()));
  expect(results.filter(result => result.acquired)).toHaveLength(1);
});

test('refuses corruption and symlinked state instead of assuming the workspace is free', async () => {
  await admission('manual', 'manual').tryAcquire();
  const file = join(home, 'workspace-turn-admission.v1', 'owners.json');
  await writeFile(file, '{broken', { mode: 0o600 });
  await expect(admission('automation-run:r1', 'automation').tryAcquire()).rejects.toThrow();
  await rm(file); const other = join(home, 'elsewhere'); await writeFile(other, '{}'); await symlink(other, file);
  await expect(admission('automation-run:r1', 'automation').tryAcquire()).rejects.toThrow();
});

test('refuses a registry with relative roots instead of skipping its claimed workspace', async () => {
  await admission('manual', 'manual').tryAcquire();
  const file = join(home, 'workspace-turn-admission.v1', 'owners.json');
  const state = JSON.parse(await readFile(file, 'utf8')); state.owners[0].roots = ['relative/root'];
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  await expect(admission('automation-run:r1', 'automation').tryAcquire()).rejects.toThrow();
});

test('recovers only release authority from a saved owner token, never permission to start another provider', async () => {
  const owner = admission('automation-run:r1', 'automation');
  await owner.tryAcquire();
  const recovered = createWorkspaceTurnAdmission({ home, sessionId: 'automation-run:r1', kind: 'automation', roots: [workspace],
    bootId: fixtureBoot, ownerToken: owner.ownerToken });
  expect(await recovered.tryAcquire()).toMatchObject({ acquired: false });
  expect(await recovered.release(false)).toBe(false);
  expect((await admission('manual', 'manual').tryAcquire()).acquired).toBe(false);
  expect(await recovered.release(true)).toBe(true);
  expect((await admission('manual', 'manual').tryAcquire()).acquired).toBe(true);
});

test('cannot use a saved token to release another session identity', async () => {
  const owner = admission('automation-run:r1', 'automation'); await owner.tryAcquire();
  const other = createWorkspaceTurnAdmission({ home, sessionId: 'automation-run:other', kind: 'automation', roots: [workspace],
    bootId: fixtureBoot, ownerToken: owner.ownerToken });
  await expect(other.release(true)).rejects.toThrow('WORKSPACE_ADMISSION_IDENTITY_CONFLICT');
  expect((await admission('manual', 'manual').tryAcquire()).acquired).toBe(false);
});

const filesystemFactory = () => (module as typeof module & {
  createFilesystemWriteAdmission(input: { home: string }): <T>(work: () => Promise<T>) => Promise<T>
}).createFilesystemWriteAdmission({ home });

test('rejects a filesystem writer without performing its effect while automatic ownership remains', async () => {
  const auto = createWorkspaceTurnAdmission({ home, sessionId: 'automation-run:r1', kind: 'automation', roots: [workspace] });
  await auto.tryAcquire(); let called = false;
  await expect(filesystemFactory()(async () => { called = true; })).rejects.toThrow('WORKSPACE_BUSY');
  expect(called).toBe(false);
});

test.each(['completed', 'failed'])('holds automation until the filesystem producer has %s and releases only that operation', async outcome => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const writer = filesystemFactory()(async () => { entered(); await pending; if (outcome === 'failed') throw new Error('synthetic filesystem failure'); return 42; });
  const settled = writer.then(value => ({ value }), error => ({ error: String(error) }));
  await started;
  const auto = createWorkspaceTurnAdmission({ home, sessionId: 'automation-run:r1', kind: 'automation', roots: [workspace] });
  try { expect((await auto.tryAcquire()).acquired).toBe(false); }
  finally { finish(); await settled; }
  expect(await settled).toEqual(outcome === 'failed' ? { error: 'Error: synthetic filesystem failure' } : { value: 42 });
  expect((await auto.tryAcquire()).acquired).toBe(true);
});

test('distinguishes an unconfirmed old owner from a live busy workspace without executing the write', async () => {
  const auto = createWorkspaceTurnAdmission({ home, sessionId: 'automation-run:r1', kind: 'automation', roots: [workspace] });
  await auto.tryAcquire();
  const file = join(home, 'workspace-turn-admission.v1', 'owners.json');
  const value = JSON.parse(await readFile(file, 'utf8')); value.owners[0].pid = 2_147_483_647;
  await writeFile(file, JSON.stringify(value)); let called = false;
  await expect(filesystemFactory()(async () => { called = true; })).rejects.toMatchObject({ code: 'WORKSPACE_OWNER_UNCONFIRMED' });
  expect(called).toBe(false);
});

test('reports an indeterminate mutation receipt when its filesystem ownership cannot be released', async () => {
  await expect(filesystemFactory()(async () => {
    await rm(join(home, 'workspace-turn-admission.v1', 'owners.json'));
  })).rejects.toMatchObject({ code: 'WORKSPACE_FILESYSTEM_RELEASE_UNCONFIRMED' });
});

const unfencedFactory = () => (module as typeof module & {
  createUnfencedSubprocessAdmission(input: { home: string; bootId?: string | null }): <T>(roots: readonly string[], work: () => Promise<T>) => Promise<T>
}).createUnfencedSubprocessAdmission({ home, bootId: fixtureBoot });

test('persists an unconfirmed folder before invoking a legacy subprocess and never infers drainage from its completion', async () => {
  const run = unfencedFactory(), auto = admission('automation-run:r1', 'automation');
  await expect(run([workspace], async () => {
    expect(await auto.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
    return 42;
  })).resolves.toBe(42);
  expect(await auto.tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
  expect((await admission('legacy-manual', 'manual').tryAcquire()).acquired).toBe(true);
  const other = join(home, 'other'); await mkdir(other);
  expect((await admission('automation-run:other', 'automation', [other]).tryAcquire()).acquired).toBe(true);
  await expect(run([workspace], async () => { throw new Error('legacy error'); })).rejects.toThrow('legacy error');
  expect(await auto.tryAcquire()).toHaveProperty('reason', 'workspace-owner-unconfirmed');
});

test('does not run or leave an unconfirmed legacy producer when an automatic owner already holds its folder', async () => {
  const auto = admission('automation-run:r1', 'automation'); await auto.tryAcquire(); let ran = false;
  await expect(unfencedFactory()([workspace], async () => { ran = true; })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  expect(ran).toBe(false); await auto.release(true);
  expect((await admission('automation-run:r2', 'automation').tryAcquire()).acquired).toBe(true);
});

test('coalesces repeated unfenced producers by folder and boot without removing another active reservation', async () => {
  const manual = admission('ordinary', 'manual'); await manual.tryAcquire();
  const run = unfencedFactory();
  for (let i = 0; i < 4; i++) await run([workspace], async () => undefined);
  const state = JSON.parse(await readFile(join(home, 'workspace-turn-admission.v1', 'owners.json'), 'utf8'));
  expect(state.owners.filter((owner: any) => owner.kind === 'unfenced')).toHaveLength(1);
  expect(state.owners.some((owner: any) => owner.token === manual.ownerToken)).toBe(true);
  expect(await manual.release(true)).toBe(true);
  expect((await admission('automation-run:r1', 'automation').tryAcquire()).acquired).toBe(false);
  expect((await createWorkspaceTurnAdmission({ home, sessionId: 'automation-run:unknown', kind: 'automation', roots: [workspace], bootId: null }).tryAcquire()).acquired).toBe(false);
  expect((await admission('automation-run:reboot', 'automation', [workspace], 'boot-B').tryAcquire()).acquired).toBe(true);
});

test.each([[false, false], [true, false], [true, true]] as const)('treats linked worktrees as one repository after Git repair=%s and rename=%s', async (repair, move) => {
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const sibling = join(home, 'linked');
  execFileSync('git', ['-C', workspace, 'worktree', 'add', '-qb', 'fixture-linked', sibling]);
  const pointer = await readFile(join(sibling, '.git'), 'utf8');
  if (repair) await writeFile(join(sibling, '.git'), 'incomplete');
  await unfencedFactory()([sibling], async () => { if (repair) await writeFile(join(sibling, '.git'), pointer); });
  if (move) await module.createFilesystemWriteAdmission({ home })(async () => { await rename(sibling, join(home, 'moved-checkout')); });
  expect(await admission('automation-run:r1', 'automation').tryAcquire()).toMatchObject({ acquired: false, reason: 'workspace-owner-unconfirmed' });
  const separate = join(home, 'unrelated'); await mkdir(separate);
  expect((await admission('automation-run:unrelated', 'automation', [separate]).tryAcquire()).acquired).toBe(true);
});

test('preserves a not-yet-created clone target suffix without blocking its sibling and refuses dangling aliases', async () => {
  const target = join(home, 'new-clone'), sibling = join(home, 'sibling'); await mkdir(sibling);
  const candidate = await dispatchFactory()([target]);
  if (!candidate.acquired) throw new Error('fixture admission refused');
  expect((await admission('automation-run:preparation', 'automation', [target]).tryAcquire()).acquired).toBe(false);
  await mkdir(target);
  await unfencedFactory()([target], async () => undefined);
  await candidate.finish();
  expect(await admission('automation-run:target', 'automation', [target]).tryAcquire()).toHaveProperty('reason', 'workspace-owner-unconfirmed');
  expect((await admission('automation-run:sibling', 'automation', [sibling]).tryAcquire()).acquired).toBe(true);
  const moved = join(home, 'moved-clone'); await rename(target, moved);
  expect(await admission('automation-run:moved-clone', 'automation', [moved]).tryAcquire()).toHaveProperty('reason', 'workspace-owner-unconfirmed');
  const dangling = join(home, 'dangling'); await symlink(join(home, 'absent'), dangling);
  let ran = false;
  await expect(unfencedFactory()([join(dangling, 'child')], async () => { ran = true; })).rejects.toThrow();
  expect(ran).toBe(false);
});

test('holds automatic repository admission when a registered checkout is replaced by a symlink outside its legacy parent', async () => {
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const parent = join(home, 'legacy-parent'), target = join(home, 'outside'); await mkdir(parent); await mkdir(target);
  const checkout = join(parent, 'checkout');
  execFileSync('git', ['-C', workspace, 'worktree', 'add', '-qb', 'fixture-alias', checkout]);
  await unfencedFactory()([parent], async () => {
    await rename(checkout, join(parent, 'moved')); await symlink(target, checkout);
  });
  await expect(admission('automation-run:alias', 'automation').tryAcquire()).rejects.toThrow('WORKSPACE_REPOSITORY_IDENTITY_UNCONFIRMED');
});

test('requires an existing folder identity before submitting an untracked subprocess', async () => {
  let called = false;
  await expect(unfencedFactory()([join(home, 'absent')], async () => { called = true; })).rejects.toThrow();
  expect(called).toBe(false);
});

test('preserves the original legacy result when the operation creates incomplete Git metadata', async () => {
  await expect(unfencedFactory()([workspace], async () => { await mkdir(join(workspace, '.git')); return 42; })).resolves.toBe(42);
  await expect(unfencedFactory()([workspace], async () => 43)).resolves.toBe(43);
  await expect(admission('automation-run:unconfirmed-git', 'automation').tryAcquire()).rejects.toThrow();
  await unfencedFactory()([workspace], async () => { execFileSync('git', ['init', '-q', workspace]); });
  expect(await admission('automation-run:repaired-git', 'automation').tryAcquire()).toHaveProperty('reason', 'workspace-owner-unconfirmed');
});

test('retains an unfenced folder identity across rename and same-path replacement without blocking unrelated siblings', async () => {
  const run = unfencedFactory(); await run([workspace], async () => undefined);
  const moved = join(home, 'moved'); await rename(workspace, moved); await mkdir(workspace);
  await run([workspace], async () => undefined);
  expect(await admission('automation-run:moved', 'automation', [moved]).tryAcquire()).toHaveProperty('reason', 'workspace-owner-unconfirmed');
  expect((await admission('ordinary-moved', 'manual', [moved]).tryAcquire()).acquired).toBe(true);
  const sibling = join(home, 'separate'); await mkdir(sibling);
  expect((await admission('automation-run:separate', 'automation', [sibling]).tryAcquire()).acquired).toBe(true);
});

test('keeps a nested unfenced scope blocked when its parent folder is renamed', async () => {
  await unfencedFactory()([join(workspace, 'child')], async () => undefined);
  const moved = join(home, 'moved'); await rename(workspace, moved);
  expect(await admission('automation-run:parent', 'automation', [moved]).tryAcquire()).toHaveProperty('reason', 'workspace-owner-unconfirmed');
});

const dispatchFactory = () => (module as typeof module & {
  createLegacyDispatchAdmission(input: { home: string; bootId?: string | null }): (roots: readonly string[]) => Promise<
    { acquired: false; reason: string } | { acquired: true; finish(): Promise<void> }>
}).createLegacyDispatchAdmission({ home, bootId: fixtureBoot });

test('reserves a legacy occurrence before claim and hands off only its own reservation', async () => {
  const reserve = dispatchFactory(), candidate = await reserve([workspace]);
  expect(candidate.acquired).toBe(true);
  if (!candidate.acquired) throw new Error('fixture admission refused');
  expect((await admission('automation-run:r1', 'automation').tryAcquire()).acquired).toBe(false);
  expect((await admission('concurrent-manual', 'manual').tryAcquire()).acquired).toBe(true);
  await unfencedFactory()([workspace], async () => undefined);
  await candidate.finish();
  expect(await admission('automation-run:r2', 'automation').tryAcquire()).toHaveProperty('reason', 'workspace-owner-unconfirmed');
});

test('leaves a blocked legacy candidate unclaimed and releases a proven non-dispatch without a sticky scope', async () => {
  const auto = admission('automation-run:r1', 'automation'); await auto.tryAcquire();
  expect((await dispatchFactory()([workspace])).acquired).toBe(false);
  await auto.release(true);
  const skipped = await dispatchFactory()([workspace]);
  if (!skipped.acquired) throw new Error('fixture admission refused');
  await skipped.finish();
  expect((await admission('automation-run:r2', 'automation').tryAcquire()).acquired).toBe(true);
});

test('does not admit a stale folder snapshot when a normal filesystem rename races its registry admission', async () => {
  await unfencedFactory()([workspace], async () => undefined);
  const target = join(home, 'target'), displaced = join(home, 'displaced'); await mkdir(target);
  const canonicalTarget = await realpath(target);
  let moved = false, observed = false;
  statHook.observe = async (path, bigint) => {
    if (observed || path !== canonicalTarget || !bigint) return;
    observed = true;
    try {
      await module.createFilesystemWriteAdmission({ home })(async () => {
        await rename(target, displaced); await rename(workspace, target); moved = true;
      });
    } catch (error) {
      // If automatic admission owns the registry first, the normal filesystem mutation must wait.
      expect((error as { code?: string }).code).toBe('WORKSPACE_REGISTRY_BUSY');
    }
  };
  const result = await admission('automation-run:race', 'automation', [target]).tryAcquire();
  expect(observed).toBe(true);
  expect(result.acquired && moved).toBe(false);
});
