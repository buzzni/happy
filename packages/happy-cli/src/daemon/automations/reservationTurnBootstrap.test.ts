import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let root: string | undefined;
const stagedHandles: Array<{ close(): void }> = [];
function stage<T extends { close(): void }>(value: T): T { stagedHandles.push(value); return value; }
afterEach(async () => { stagedHandles.splice(0).forEach(value => value.close()); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetModules(); if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reservation-bootstrap-')));
  const baseDirectory = join(root, 'base'), executionDirectory = join(root, 'worktree'); await mkdir(baseDirectory); await mkdir(executionDirectory);
  const module = await import('./reservationTurnBootstrap');
  const clock = await import('./reservationMonotonicClock');
  const value: import('./reservationTurnBootstrap').ReservationTurnBootstrap = { version: 1, runId: 'run', sessionId: 'same-chat', epoch: 'epoch', descriptorHash: 'a'.repeat(64), provider: 'claude', nativeId: '12345678-1234-4234-8234-123456789abc', baseDirectory, executionDirectory, messageAuthorization: 'epoch.' + 'a'.repeat(43), deadlineMonotonicMs: clock.reservationMonotonicNow() + 60000 };
  const env = { HAPPY_RESERVATION_BOOTSTRAP_FD: String(stage(module.stageReservationTurnBootstrap(value)).fd) };
  return { module, value, env };
}
it('consumes the capability before provider imports and allows only the exact saved conversation', async () => {
  const f = await fixture(); f.module.captureReservationTurnBootstrap(f.env, ['claude'], f.value.executionDirectory);
  expect(f.env).not.toHaveProperty('HAPPY_RESERVATION_BOOTSTRAP_FD');
  expect(f.module.reservationSessionOptions('same-chat')).toEqual({ reservation: { sessionId: 'same-chat', authorization: f.value.messageAuthorization } });
  expect(() => f.module.reservationSessionOptions('foreign')).toThrow('RESERVATION_SESSION_MISMATCH');
  expect(() => f.module.assertReservationSessionCreationAllowed()).toThrow('RESERVATION_NEW_CONVERSATION_FORBIDDEN');
  expect(() => f.module.assertReservationProviderResume('claude', f.value.nativeId)).not.toThrow();
  expect(() => f.module.assertReservationProviderResume('claude', null)).toThrow('RESERVATION_NATIVE_RESUME_REQUIRED');
  expect(() => f.module.assertReservationProviderResume('codex', f.value.nativeId)).toThrow('RESERVATION_NATIVE_RESUME_REQUIRED');
});
it('fails closed on a different process directory or malformed authority and removes the rejected environment value', async () => {
  const f = await fixture();
  expect(() => f.module.captureReservationTurnBootstrap(f.env, ['claude'], f.value.baseDirectory)).toThrow('RESERVATION_BOOTSTRAP_INVALID');
  expect(f.env).not.toHaveProperty('HAPPY_RESERVATION_BOOTSTRAP_FD');
  const malformed = { HAPPY_RESERVATION_BOOTSTRAP_V1: JSON.stringify({ ...f.value, messageAuthorization: 'other.' + 'a'.repeat(43) }) };
  expect(() => f.module.captureReservationTurnBootstrap(malformed, ['claude'], f.value.executionDirectory)).toThrow('RESERVATION_BOOTSTRAP_INVALID');
  expect(malformed).not.toHaveProperty('HAPPY_RESERVATION_BOOTSTRAP_FD');
});
it('keeps normal reservations and ordinary sessions unchanged without a bootstrap', async () => {
  const module = await import('./reservationTurnBootstrap'); module.captureReservationTurnBootstrap({}, ['claude']);
  expect(module.reservationSessionOptions('ordinary')).toEqual({});
  expect(() => module.assertReservationSessionCreationAllowed()).not.toThrow();
  expect(() => module.assertReservationProviderResume('claude', null)).not.toThrow();
});

it('blocks the real create and fork boundaries and preserves the saved metadata directory', async () => {
  const f = await fixture(); f.module.captureReservationTurnBootstrap(f.env, ['claude'], f.value.executionDirectory);
  const { ApiClient } = await import('@/api/api');
  const api = await ApiClient.create({ token: 'fixture-account', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
  await expect(api.getOrCreateSession({} as never)).rejects.toThrow('RESERVATION_NEW_CONVERSATION_FORBIDDEN');
  const { CodexAppServerClient } = await import('@/codex/codexAppServerClient');
  const codex = Object.create(CodexAppServerClient.prototype) as InstanceType<typeof CodexAppServerClient>;
  await expect(codex.startThread({})).rejects.toThrow('RESERVATION_NEW_CONVERSATION_FORBIDDEN');
  await expect(codex.forkThread({ threadId: f.value.nativeId })).rejects.toThrow('RESERVATION_NEW_CONVERSATION_FORBIDDEN');
  expect(codex.sideCommandAllowed).toBe(false);
  const { startHappyServer } = await import('@/claude/utils/startHappyServer');
  await expect(startHappyServer({ sessionId: 'same-chat' } as never)).rejects.toThrow('RESERVATION_SCOPED_TOOL_BROKER_REQUIRED');
  expect(() => f.module.assertReservationMetadata({ path: f.value.executionDirectory, claudeSessionId: f.value.nativeId })).toThrow('RESERVATION_BASE_DIRECTORY_MISMATCH');
  expect(() => f.module.assertReservationMetadata({ path: f.value.baseDirectory, claudeSessionId: f.value.nativeId })).not.toThrow();
});

it('renews only a live matching epoch on the monotonic clock and never resurrects expiry', async () => {
  const f = await fixture();
  const clock = await import('./reservationMonotonicClock');
  let monotonic = clock.reservationMonotonicNow();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.spyOn(clock, 'reservationMonotonicNow').mockImplementation(() => monotonic);
  f.value.deadlineMonotonicMs = monotonic + 1000; f.env.HAPPY_RESERVATION_BOOTSTRAP_FD = String(stage(f.module.stageReservationTurnBootstrap(f.value)).fd);
  f.module.captureReservationTurnBootstrap(f.env, ['claude'], f.value.executionDirectory);
  monotonic += 500; vi.advanceTimersByTime(500);
  expect(f.module.renewReservationTurnAuthority('foreign', monotonic + 2000)).toBe(false);
  expect(f.module.renewReservationTurnAuthority('epoch', monotonic + 2000)).toBe(true);
  vi.setSystemTime(Date.now() - 3600000);
  monotonic += 1000; vi.advanceTimersByTime(1000);
  expect(f.module.reservationTurnAuthoritySignal()?.aborted).toBe(false);
  monotonic += 1001; vi.advanceTimersByTime(1001);
  expect(f.module.reservationTurnAuthoritySignal()?.aborted).toBe(true);
  expect(f.module.renewReservationTurnAuthority('epoch', monotonic + 2000)).toBe(false);
});

it('stages a one-shot inherited descriptor instead of exposing authority in environment variables', async () => {
  const f = await fixture();
  const staged = stage(f.module.stageReservationTurnBootstrap(f.value));
  const environment = { HAPPY_RESERVATION_BOOTSTRAP_FD: String(staged.fd) };
  expect(JSON.stringify(environment)).not.toContain(f.value.messageAuthorization);
  f.module.captureReservationTurnBootstrap(environment, ['claude'], f.value.executionDirectory);
  expect(environment).not.toHaveProperty('HAPPY_RESERVATION_BOOTSTRAP_FD');
  expect(f.module.reservationSessionOptions('same-chat')).toEqual({ reservation: { sessionId: 'same-chat', authorization: f.value.messageAuthorization } });
});

it('transfers authority through an actual inherited FD and removes it before any later child can inherit it', async () => {
  const f = await fixture(), staged = stage(f.module.stageReservationTurnBootstrap(f.value));
  const script = join(f.value.executionDirectory, 'fd-probe.ts');
  const source = join(process.cwd(), 'src/daemon/automations/reservationTurnBootstrap.ts');
  await writeFile(script, `import { captureReservationTurnBootstrap, reservationSessionOptions } from ${JSON.stringify(source)};
    import { fstatSync } from 'node:fs';
    captureReservationTurnBootstrap(process.env, ['claude']);
    let closed = false; try { fstatSync(3); } catch { closed = true; }
    process.stdout.write(JSON.stringify({ session: reservationSessionOptions('same-chat').reservation?.sessionId, closed,
      variables: Object.keys(process.env).filter(key => key.startsWith('HAPPY_RESERVATION_')) }));`);
  const require = createRequire(import.meta.url);
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), script], {
    cwd: f.value.executionDirectory, env: { PATH: process.env.PATH, HAPPY_RESERVATION_BOOTSTRAP_FD: '3' },
    stdio: ['ignore', 'pipe', 'pipe', staged.fd],
  });
  staged.close(); let output = '', errors = '';
  child.stdout!.on('data', value => { output += value; }); child.stderr!.on('data', value => { errors += value; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bootstrap probe timeout')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', status => { clearTimeout(timer); resolve(status); });
  });
  expect(errors).toBe(''); expect(code).toBe(0);
  expect(JSON.parse(output)).toEqual({ session: 'same-chat', closed: true, variables: [] });
  expect(output).not.toContain(f.value.messageAuthorization);
});
