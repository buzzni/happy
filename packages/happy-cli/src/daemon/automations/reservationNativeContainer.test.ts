import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReservationNativeContainers, reservationDocker, type ReservationContainer, type ReservationContainerScope } from './reservationNativeContainer';
import { reservationMonotonicNow } from './reservationMonotonicClock';
import * as clock from './reservationMonotonicClock';
import { runInNewContext } from 'node:vm';
import { reservationContainerLabels } from './reservationNativeContainer';
const scopes: Array<{ scope: ReservationContainerScope; handle?: ReservationContainer }> = [], roots: string[] = [];
const scope = (): ReservationContainerScope => ({ owner: 'a'.repeat(64), descriptorHash: 'b'.repeat(64), runId: randomUUID(), sessionId: 'same-chat', epoch: randomUUID() });
afterEach(async () => {
  vi.restoreAllMocks();
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

it('does not extend kernel deadlines when Docker clock, create, start or renew commands are delayed', async () => {
  let hostNow = 1000, bootNow = 101000, lease: any;
  vi.spyOn(clock, 'reservationMonotonicNow').mockImplementation(() => hostNow);
  const advance = (ms: number) => { hostNow += ms; bootNow += ms; };
  const value = scope(), id = 'f'.repeat(64);
  const fs = { mkdirSync() {}, readFileSync: (path: string) => path === '/proc/uptime' ? String(bootNow / 1000) : JSON.stringify(lease), writeFileSync: (_: string, text: string) => { lease = JSON.parse(text); } };
  const evaluate = (script: string, args: string[]) => runInNewContext(script, { require: () => fs, process: { argv: ['node', ...args], on() {}, exit: (code: number) => { throw new Error('gate exit ' + code); } }, setInterval() {} });
  const runtime = new ReservationNativeContainers({ attach: vi.fn(), command: vi.fn(async args => {
    if (args[0] === 'info') return JSON.stringify({ OSType: 'linux', ID: 'engine' });
    if (args[0] === 'run' || args[0] === 'exec' && !args.includes('--user')) { const sample = bootNow; advance(700); return String(sample); }
    if (args[0] === 'create') { advance(800); const index = args.indexOf('-e'); evaluate(args[index + 1], args.slice(index + 2)); return id; }
    if (args[0] === 'start') { advance(900); return ''; }
    if (args[0] === 'inspect') return JSON.stringify([{ Id: id, State: { Running: true, Pid: 2, StartedAt: 'start' }, Config: { Labels: reservationContainerLabels(value) } }]);
    if (args[0] === 'exec') { advance(600); const index = args.indexOf('-e'); evaluate(args[index + 1], args.slice(index + 2)); return ''; }
    throw new Error('Unexpected Docker command');
  }) });
  const grant = hostNow + 10000;
  const handle = await runtime.prepare({ scope: value, image: 'sha256:' + 'a'.repeat(64), mounts: [], uid: 65534, gid: 65534, deadlineMonotonicMs: grant });
  expect(lease.deadline).toBeLessThanOrEqual(grant + 100000);
  advance(1000); const renewed = hostNow + 10000;
  await runtime.renew(handle, renewed);
  expect(lease.deadline).toBeLessThanOrEqual(renewed + 100000);
});
