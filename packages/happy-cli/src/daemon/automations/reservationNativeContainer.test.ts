import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReservationNativeContainers, reservationDocker, type ReservationContainer, type ReservationContainerScope } from './reservationNativeContainer';
import { reservationMonotonicNow } from './reservationMonotonicClock';
const scopes: Array<{ scope: ReservationContainerScope; handle?: ReservationContainer }> = [], roots: string[] = [];
const scope = (): ReservationContainerScope => ({ owner: 'a'.repeat(64), descriptorHash: 'b'.repeat(64), runId: randomUUID(), sessionId: 'same-chat', epoch: randomUUID() });
afterEach(async () => {
  for (const value of scopes.splice(0)) await new ReservationNativeContainers().stop(value.scope, value.handle).catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('refuses mutable images, invalid identities and expired grants before invoking Docker', async () => {
  const command = vi.fn(); const runtime = new ReservationNativeContainers({ command, attach: vi.fn() });
  const input = { scope: scope(), image: 'node:latest', mounts: [], uid: 65534, gid: 65534, deadlineMonotonicMs: reservationMonotonicNow() + 10000 };
  await expect(runtime.prepare(input)).rejects.toThrow('RESERVATION_CONTAINER_PROFILE_INVALID');
  await expect(runtime.prepare({ ...input, image: 'sha256:' + 'a'.repeat(64), deadlineMonotonicMs: 1 })).rejects.toThrow('RESERVATION_AUTHORITY_EXPIRED');
  expect(command).not.toHaveBeenCalled();
});
it('does not turn a missing container or changed engine into a successful exit receipt', async () => {
  const runtime = new ReservationNativeContainers({ command: vi.fn(async args => args[0] === 'info' ? JSON.stringify({ OSType: 'linux', ID: 'engine' }) : ''), attach: vi.fn() });
  expect(await runtime.stop(scope())).toEqual({ exited: false });
});
// Local OS verification only: immutable cached image, no network, no provider or GitHub auth.
it.skipIf(!process.env.RESERVATION_NATIVE_TEST_IMAGE)('contains detached descendants, enforces read-only mounts and protects the root-owned lease gate', async () => {
  const runtime = new ReservationNativeContainers(), value = scope(); scopes.push({ scope: value });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reservation-native-'))); roots.push(root); await chmod(root, 0o777);
  const uid = process.getuid?.() || 65534, gid = process.getgid?.() || 65534;
  const handle = await runtime.prepare({ scope: value, image: process.env.RESERVATION_NATIVE_TEST_IMAGE!, uid, gid,
    mounts: [{ source: root, target: '/project', writable: false }], deadlineMonotonicMs: reservationMonotonicNow() + 15000 });
  scopes[scopes.length - 1].handle = handle;
  const child = await runtime.execute(handle, { command: 'node', args: ['-e', `const fs=require('fs');
    let ro=false,gate=false;try{fs.writeFileSync('/project/escape','bad')}catch(e){ro=e.code==='EROFS'||e.code==='EACCES'}
    try{fs.readFileSync('/run/reservation-authority/lease')}catch(e){gate=e.code==='EACCES'}
    if(!ro||!gate||fs.existsSync('/root/.happy'))process.exit(4);
    require('child_process').spawn('node',['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'}).unref();
    console.log('ready');setTimeout(()=>{},60000);`], cwd: '/project', uid, gid });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native probe timeout')), 5000);
    child.stdout!.on('data', chunk => { output += chunk; if (output.includes('ready')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (!output.includes('ready')) { clearTimeout(timer); reject(new Error('probe exited ' + code)); } });
  });
  await runtime.renew(handle, reservationMonotonicNow() + 20000);
  expect(await runtime.stop(value, { ...handle, processStartId: 'foreign' })).toEqual({ exited: false });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  expect(await runtime.stop(value, handle)).toMatchObject({ exited: true, runtime: { launchId: handle.launchId } });
  await closed;
  expect((await reservationDocker.command(['ps', '-aq', '--filter', `id=${handle.id}`])).trim()).toBe('');
  await expect(readFile(join(root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);
