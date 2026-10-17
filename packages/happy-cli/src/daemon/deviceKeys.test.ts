import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as protection from './standaloneLaunchJournal';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, chmod, unlink, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { loadOrCreateDeviceKeys } from './deviceKeys';
const homes: string[] = [];
async function home() { const base = process.platform === 'win32' && process.env.SAYCODE_DEVICE_KEYS_TEST_ROOT || tmpdir(); const path = await mkdtemp(join(base, 'device-keys-')); homes.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true }); });
it('persists independent signing and recipient keys across reloads and machine IDs', async () => {
  const path = await home();
  const first = await loadOrCreateDeviceKeys(path, 'machine-1');
  const again = await loadOrCreateDeviceKeys(path, 'machine-1');
  expect(again).toEqual(first);
  expect(await loadOrCreateDeviceKeys(path, 'machine-2')).not.toEqual(first);
  expect(first.signing.publicKey).not.toEqual(first.recipient.publicKey);
  const message = new Uint8Array([1, 2, 3]);
  expect(nacl.sign.detached.verify(message, nacl.sign.detached(message, first.signing.secretKey), first.signing.publicKey)).toBe(true);
  expect(nacl.box.keyPair.fromSecretKey(first.recipient.secretKey).publicKey).toEqual(first.recipient.publicKey);
});
it('selects one key pair during concurrent first creation', async () => {
  const path = await home();
  const keys = await Promise.all(Array.from({ length: 20 }, () => loadOrCreateDeviceKeys(path, 'machine')));
  for (const key of keys) expect(key).toEqual(keys[0]);
  const directories = await readdir(path);
  expect(directories).toHaveLength(1);
  expect(await readdir(join(path, directories[0]))).toEqual(['keys.json']);
});
it.skipIf(process.platform === 'win32')('uses private directory and file modes', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const directory = join(path, (await readdir(path))[0]);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, 'keys.json'))).mode & 0o777).toBe(0o600);
});
it('requires reapproval after corruption or a missing key instead of silently replacing identity', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const file = join(path, (await readdir(path))[0], 'keys.json');
  await writeFile(file, '{}');
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow(/reapproval/i);
  expect(await readFile(file, 'utf8')).toBe('{}');
  await unlink(file);
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow(/reapproval/i);
  expect(await readdir(join(path, (await readdir(path))[0]))).toEqual([]);
});
// "Reapproval required" covers ACL refusals, corruption and ID mismatches alike; the daemon log needs which one.
it('keeps the underlying failure as the cause of a reapproval error', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  await writeFile(join(path, (await readdir(path))[0], 'keys.json'), '{}');
  const error = await loadOrCreateDeviceKeys(path, 'machine').then(() => null, (failure: Error) => failure);
  expect(error?.message).toMatch(/reapproval/i);
  expect(error?.cause).toBeInstanceOf(Error);
  expect((error?.cause as Error).message).not.toMatch(/reapproval/i);
});
it('names a key file that belongs to another machine as the cause', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const file = join(path, (await readdir(path))[0], 'keys.json');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), machineId: 'other' }));
  const error = await loadOrCreateDeviceKeys(path, 'machine').then(() => null, (failure: Error) => failure);
  expect((error?.cause as Error | undefined)?.message).toMatch(/another machine/);
});
it.skipIf(process.platform === 'win32')('rejects permissions widened after creation and symbolic links', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const directory = join(path, (await readdir(path))[0]);
  const file = join(directory, 'keys.json');
  const original = await readFile(file);
  await chmod(file, 0o644);
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow();
  await chmod(file, 0o600); await unlink(file);
  const target = join(path, 'target'); await writeFile(target, original, { mode: 0o600 }); await symlink(target, file);
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow();
  expect(await readFile(target)).toEqual(original);
});
it('rejects copied keys for a different machine even if the directory name matches', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const file = join(path, (await readdir(path))[0], 'keys.json');
  const record = JSON.parse(await readFile(file, 'utf8')); record.machineId = 'other';
  await writeFile(file, JSON.stringify(record));
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow(/reapproval/i);
});
it('detects structurally valid secret-key corruption by checking the stored public keys', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const file = join(path, (await readdir(path))[0], 'keys.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.signingSeed = Buffer.alloc(32, 99).toString('base64url');
  await writeFile(file, JSON.stringify(record));
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow(/reapproval/i);
});
it('rejects malformed Unicode machine IDs instead of hashing replacement characters', async () => {
  const path = await home();
  await expect(loadOrCreateDeviceKeys(path, '\ud800').then(() => true)).rejects.toThrow();
  expect(await readdir(path)).toEqual([]);
});

it('shares a single persisted identity across separate processes', async () => {
  const path = await home();
  const source = new URL('./deviceKeys.ts', import.meta.url).href;
  const script = `const {loadOrCreateDeviceKeys}=await import(${JSON.stringify(source)}); const keys=await loadOrCreateDeviceKeys(process.argv[1],'parallel-machine'); console.log(Buffer.from(keys.signing.publicKey).toString('hex')+Buffer.from(keys.recipient.publicKey).toString('hex'));`;
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], { timeout: 20000 });
  const results = await Promise.all(Array.from({ length: 4 }, run));
  expect(new Set(results.map(result => result.stdout.trim())).size).toBe(1);
  expect((await run()).stdout).toBe(results[0].stdout);
}, 30000);
it('does not write private material or recover with fresh keys after protection fails', async () => {
  const path = await home();
  const protect = vi.spyOn(protection, 'protectStandaloneObservationDirectory').mockRejectedValueOnce(new Error('ACL failed'));
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow('ACL failed');
  const directory = join(path, (await readdir(path))[0]);
  expect(await readdir(directory)).toEqual([]);
  protect.mockResolvedValue(undefined); protect.mockClear();
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow(/reapproval/i);
  expect(protect).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')('refuses a hard-linked private key file', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const file = join(path, (await readdir(path))[0], 'keys.json');
  const { link } = await import('node:fs/promises');
  await link(file, join(path, 'extra-copy'));
  await expect(loadOrCreateDeviceKeys(path, 'machine').then(() => true)).rejects.toThrow(/reapproval/i);
});
it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking the daemon', async () => {
  const path = await home(); await loadOrCreateDeviceKeys(path, 'machine');
  const file = join(path, (await readdir(path))[0], 'keys.json');
  await unlink(file); await promisify(execFile)('mkfifo', [file]);
  const source = new URL('./deviceKeys.ts', import.meta.url).href;
  const script = `const {loadOrCreateDeviceKeys}=await import(${JSON.stringify(source)}); try { await loadOrCreateDeviceKeys(process.argv[1],'machine'); process.exitCode=1; } catch { console.log('refused'); }`;
  const result = await promisify(execFile)(process.execPath, ['--import','tsx','--input-type=module','-e',script,path], { timeout: 5000 });
  expect(result.stdout.trim()).toBe('refused');
});

it.skipIf(process.platform !== 'win32' || !process.env.SAYCODE_DEVICE_KEYS_TEST_ROOT)('initializes device keys when the committed path fits the Windows ACL limit', async () => {
  // The caller supplies an already trusted private fixture root; never repair company TEMP.
  const base = await mkdtemp(join(process.env.SAYCODE_DEVICE_KEYS_TEST_ROOT!, 'dk-')); homes.push(base);
  const path = join(base, 'h'.repeat(170 - base.length - 1));
  await mkdir(path, { recursive: true, mode: 0o700 });
  const first = await loadOrCreateDeviceKeys(path, 'long-path-fixture');
  const directory = join(path, (await readdir(path))[0]);
  expect(directory.length).toBe(242);
  expect(join(directory, 'keys.json').length).toBeLessThan(260);
  expect(await readdir(directory)).toEqual(['keys.json']);
  expect(await loadOrCreateDeviceKeys(path, 'long-path-fixture')).toEqual(first);
});
