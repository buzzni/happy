import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename, realpath, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaceDirectory, readWorkspaceFile, captureWorkspacePath, writeWorkspaceFile } from './workspaceFileBoundary.ts';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'workspace-boundary-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, '한 글 project');
  const outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(root, '기획.md'), '# 정상');
  await writeFile(join(outside, 'secret.md'), 'outside');
  return { base, root, outside };
}

test('reads Unicode file content and complete metadata inside the project', async (t) => {
  const { base, root } = await fixture(t);
  const rows = await listWorkspaceDirectory(base, root, root);
  assert.equal(rows[0].name, '기획.md');
  assert.equal(rows[0].type, 'file');
  assert.equal(rows[0].size, Buffer.byteLength('# 정상'));
  assert.ok(Number.isFinite(rows[0].modified));
  assert.equal((await readWorkspaceFile(base, root, join(root, '기획.md'))).toString(), '# 정상');
});
test('rejects a sibling project and a root outside the machine boundary', async (t) => {
  const { base, root, outside } = await fixture(t);
  await assert.rejects(readWorkspaceFile(base, root, join(outside, 'secret.md')), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(listWorkspaceDirectory(root, outside, outside), { code: 'WORKSPACE_PATH_DENIED' });
});
test('rejects a linked project root and nested directory junction', async (t) => {
  const { base, root, outside } = await fixture(t);
  const link = join(root, 'linked');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, link, type);
  const rows = await listWorkspaceDirectory(base, root, root);
  assert.equal(rows.find((row) => row.name === 'linked').type, 'other');
  await assert.rejects(listWorkspaceDirectory(base, root, link), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(readWorkspaceFile(base, root, join(link, 'secret.md')), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(listWorkspaceDirectory(base, link, link), { code: 'WORKSPACE_PATH_DENIED' });
});
test('rejects replacing a previously verified directory with a junction', async (t) => {
  const { base, root, outside } = await fixture(t);
  const directory = join(root, 'docs');
  await mkdir(directory);
  const snapshot = await captureWorkspacePath(base, root, directory);
  await rename(directory, `${directory}-old`);
  await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshot.verify(), { code: 'WORKSPACE_PATH_DENIED' });
});
test('preserves structured ENOENT without matching error path text', async (t) => {
  const { base, root } = await fixture(t);
  await assert.rejects(readWorkspaceFile(base, root, join(root, 'missing.md')), { code: 'ENOENT' });
});
test('rejects relative roots, NULs, and Windows alternate stream syntax', async (t) => {
  const { base, root } = await fixture(t);
  await assert.rejects(listWorkspaceDirectory(base, '.', root), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(listWorkspaceDirectory(base, root, `${root}\0`), { code: 'WORKSPACE_PATH_DENIED' });
  if (process.platform === 'win32') {
    await assert.rejects(readWorkspaceFile(base, root, `${join(root, '기획.md')}:stream`), { code: 'WORKSPACE_PATH_DENIED' });
  }
});
test('accepts the native filesystem root as the machine boundary', async (t) => {
  const { root } = await fixture(t);
  const { parse } = await import('node:path');
  const canonicalRoot = await realpath(root);
  const snapshot = await captureWorkspacePath(parse(canonicalRoot).root, canonicalRoot, canonicalRoot);
  await snapshot.verify();
});
test('rejects symlink files and oversized reads', async (t) => {
  const { base, root, outside } = await fixture(t);
  await symlink(join(outside, 'secret.md'), join(root, 'link.md'), 'file');
  await assert.rejects(readWorkspaceFile(base, root, join(root, 'link.md')), { code: 'WORKSPACE_PATH_DENIED' });
  await writeFile(join(root, 'large.md'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readWorkspaceFile(base, root, join(root, 'large.md')), { code: 'WORKSPACE_LIMIT' });
});
test('reports genuine missing files with a structured code', async (t) => {
  const { base, root } = await fixture(t);
  await assert.rejects(readWorkspaceFile(base, root, join(root, 'missing.md')), { code: 'ENOENT' });
});

const dirLink = process.platform === 'win32' ? 'junction' : 'dir';

test('creates missing directories one by one and writes a new file inside the project', async (t) => {
  const { base, root } = await fixture(t);
  const target = join(root, '.ax', 'session-digests', 'req-1', 'index.md');
  await writeWorkspaceFile(base, root, target, Buffer.from('# 요약'));
  assert.equal(await readFile(target, 'utf8'), '# 요약');
});
test('refuses to overwrite an existing file with a structured EEXIST', async (t) => {
  const { base, root } = await fixture(t);
  await assert.rejects(writeWorkspaceFile(base, root, join(root, '기획.md'), Buffer.from('x')), { code: 'EEXIST' });
  assert.equal(await readFile(join(root, '기획.md'), 'utf8'), '# 정상');
});
test('refuses a linked ancestor without writing through it', async (t) => {
  const { base, root, outside } = await fixture(t);
  await symlink(outside, join(root, '.ax'), dirLink);
  await assert.rejects(writeWorkspaceFile(base, root, join(root, '.ax', 'session-digests', 'r', 'index.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  assert.deepEqual(await readdir(outside), ['secret.md']);
});
test('refuses a linked intermediate directory below an existing ancestor', async (t) => {
  const { base, root, outside } = await fixture(t);
  await mkdir(join(root, '.ax', 'session-digests'), { recursive: true });
  await symlink(outside, join(root, '.ax', 'session-digests', 'r'), dirLink);
  await assert.rejects(writeWorkspaceFile(base, root, join(root, '.ax', 'session-digests', 'r', 'index.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  assert.deepEqual(await readdir(outside), ['secret.md']);
});
test('refuses a linked final file, even a dangling one, without following it', async (t) => {
  const { base, root, outside } = await fixture(t);
  await symlink(join(outside, 'secret.md'), join(root, 'existing-link.md'), 'file');
  await symlink(join(outside, 'planted.md'), join(root, 'dangling-link.md'), 'file');
  await assert.rejects(writeWorkspaceFile(base, root, join(root, 'existing-link.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(writeWorkspaceFile(base, root, join(root, 'dangling-link.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), 'outside');
  assert.deepEqual(await readdir(outside), ['secret.md']);
});
test('refuses a non-directory ancestor', async (t) => {
  const { base, root } = await fixture(t);
  await assert.rejects(writeWorkspaceFile(base, root, join(root, '기획.md', 'child.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(writeWorkspaceFile(base, root, join(root, '기획.md', 'deeper', 'child.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
});
test('refuses paths outside the project, the project root itself, and a linked project root', async (t) => {
  const { base, root, outside } = await fixture(t);
  await assert.rejects(writeWorkspaceFile(base, root, join(outside, 'new.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(writeWorkspaceFile(base, root, join(root, '..', 'outside', 'new.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(writeWorkspaceFile(base, root, root, Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  await assert.rejects(writeWorkspaceFile(base, '.', join(root, 'new.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  const linkedRoot = join(base, 'linked-root');
  await symlink(outside, linkedRoot, dirLink);
  await assert.rejects(writeWorkspaceFile(base, linkedRoot, join(linkedRoot, 'new.md'), Buffer.from('x')), { code: 'WORKSPACE_PATH_DENIED' });
  assert.deepEqual(await readdir(outside), ['secret.md']);
});
