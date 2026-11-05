import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceTurnAdmission } from './workspaceTurnAdmission';
import * as module from './workspaceTurnAdmission';

const test = it.skipIf(process.platform === 'win32');
let home: string, workspace: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workspace-turn-admission-'));
  workspace = join(home, 'project'); await mkdir(join(workspace, 'child'), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const admission = (sessionId: string, kind: 'manual' | 'automation', roots = [workspace], bootId = 'boot-A') =>
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
    bootId: 'boot-A', ownerToken: owner.ownerToken });
  expect(await recovered.tryAcquire()).toMatchObject({ acquired: false });
  expect(await recovered.release(false)).toBe(false);
  expect((await admission('manual', 'manual').tryAcquire()).acquired).toBe(false);
  expect(await recovered.release(true)).toBe(true);
  expect((await admission('manual', 'manual').tryAcquire()).acquired).toBe(true);
});

test('cannot use a saved token to release another session identity', async () => {
  const owner = admission('automation-run:r1', 'automation'); await owner.tryAcquire();
  const other = createWorkspaceTurnAdmission({ home, sessionId: 'automation-run:other', kind: 'automation', roots: [workspace],
    bootId: 'boot-A', ownerToken: owner.ownerToken });
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
