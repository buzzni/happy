import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSessionRetention, retentionProtects, type RetentionRecord } from './sessionRetention';
import { evaluateBusyOnlyStopGuard, evaluateIdleStopGuard, readIdleStopGuardConfig, resolveStopSessionMode, runDaemonSessionIdleReaperTick } from './sessionIdleReaper';
import type { TrackedSession } from './types';

const HOUR = 3600000;
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'retention-')); dirs.push(home);
  let now = 10 * HOUR;
  let children: TrackedSession[] = [{ pid: 123, startedBy: 'daemon', happySessionId: 'a', runtime: {
    thinking: false, hasOpenToolCall: false, updatedAt: now, lastTurnEndAt: now - 2 * HOUR,
  } }];
  const open = () => createSessionRetention({ home, now: () => now, children: () => children });
  return { home, open, setTime: (t: number) => { now = t; }, clear: () => { children = []; } };
}
describe('session retention at the daemon boundary', () => {
  it('preserves confirmed policy and allows retry after a pre-rename disk failure', async () => {
    const h = fixture(), service = h.open();
    await service.set({ sessionId: 'a', policy: { mode: 'keep-alive' }, expectedRevision: 0 });
    const before = fs.readFileSync(join(h.home, 'session-retention.v1.json'), 'utf8'), original = fs.openSync;
    let fail = true;
    const fault = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith('.tmp') && fail) { fail = false; throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); }
      return original(...args);
    });
    syncBuiltinESMExports();
    await expect(service.set({ sessionId: 'a', policy: { mode: 'default' }, expectedRevision: 1 })).rejects.toThrow('RETENTION_STORE_UNAVAILABLE');
    fault.mockRestore(); syncBuiltinESMExports();
    expect(fs.readFileSync(join(h.home, 'session-retention.v1.json'), 'utf8')).toBe(before);
    expect(await service.get({ sessionId: 'a' })).toMatchObject({ policy: { mode: 'keep-alive' }, revision: 1 });
    expect(await service.set({ sessionId: 'a', policy: { mode: 'default' }, expectedRevision: 1 })).toMatchObject({ revision: 2 });
  });
  it.skipIf(process.platform === 'win32')('holds an indeterminate policy after rename when directory fsync fails', async () => {
    const h = fixture(), service = h.open(), original = fs.fsyncSync;
    let calls = 0;
    const fault = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (++calls === 2) throw Error('directory fsync failed'); original(fd); });
    syncBuiltinESMExports();
    await expect(service.set({ sessionId: 'a', policy: { mode: 'keep-alive' }, expectedRevision: 0 })).rejects.toThrow('RETENTION_STORE_UNAVAILABLE');
    fault.mockRestore(); syncBuiltinESMExports();
    await expect(service.get({ sessionId: 'a' })).rejects.toThrow('RETENTION_STORE_UNAVAILABLE');
    expect(await h.open().get({ sessionId: 'a' })).toMatchObject({ revision: 1 });
  });
  it('persists only the chosen conversation, restores after restart and rejects stale writes', async () => {
    const h = fixture(), service = h.open();
    expect(await service.get({ sessionId: 'a' })).toMatchObject({ version: 1, policy: { mode: 'default' }, revision: 0 });
    const saved = await service.set({ sessionId: 'a', policy: { mode: 'keep-alive' }, expectedRevision: 0 });
    expect(saved).toMatchObject({ policy: { mode: 'keep-alive' }, revision: 1 });
    expect(await h.open().get({ sessionId: 'a' })).toEqual(saved);
    expect(h.open().record('b')).toBeUndefined();
    await expect(service.set({ sessionId: 'a', policy: { mode: 'default' }, expectedRevision: 0 })).rejects.toThrow('RETENTION_CONFLICT');
    expect(service.record('a')?.policy).toEqual({ mode: 'keep-alive' });
  });
  it('refuses malformed policy, unknown/PID targets and stopped processes without resuming them', async () => {
    const h = fixture(), service = h.open();
    for (const policy of [{ mode: 'idle', durationMs: -1 }, { mode: 'idle', durationMs: 1 }, { mode: 'keep-alive', extra: true }]) {
      await expect(service.set({ sessionId: 'a', policy, expectedRevision: 0 })).rejects.toThrow();
    }
    await expect(service.set({ sessionId: 'PID-123', policy: { mode: 'keep-alive' }, expectedRevision: 0 })).rejects.toThrow();
    await expect(service.get({ sessionId: 'other' })).rejects.toThrow('RETENTION_STOPPED');
    h.clear();
    await expect(service.set({ sessionId: 'a', policy: { mode: 'keep-alive' }, expectedRevision: 0 })).rejects.toThrow('RETENTION_STOPPED');
  });
  it('does not acknowledge or overwrite an unreadable store', async () => {
    const h = fixture(), service = h.open();
    writeFileSync(join(h.home, 'session-retention.v1.json'), '{broken');
    await expect(service.get({ sessionId: 'a' })).rejects.toThrow('RETENTION_STORE_UNAVAILABLE');
    await expect(service.set({ sessionId: 'a', policy: { mode: 'keep-alive' }, expectedRevision: 0 })).rejects.toThrow('RETENTION_STORE_UNAVAILABLE');
  });
  it('counts from selection or actual activity/turn end, never heartbeat', () => {
    const record: RetentionRecord = { policy: { mode: 'idle', durationMs: HOUR }, configuredAt: 2 * HOUR, revision: 1 };
    expect(retentionProtects(record, { updatedAt: 3 * HOUR - 1 }, 3 * HOUR - 1)).toBe(true);
    expect(retentionProtects(record, { updatedAt: 3 * HOUR }, 3 * HOUR)).toBe(false);
    expect(retentionProtects(record, { lastUserInteractionAt: 2.5 * HOUR }, 3 * HOUR)).toBe(true);
    expect(retentionProtects(record, { lastTurnEndAt: 2.5 * HOUR }, 3 * HOUR)).toBe(true);
  });
  it('protects a healthy waiting process at the final idle guard; expiry and default permit normal cleanup', () => {
    const input = { startedBy: 'daemon', now: 10 * HOUR, sessionStartedAt: HOUR, config: readIdleStopGuardConfig({}),
      runtime: { thinking: false, hasOpenToolCall: false, updatedAt: 10 * HOUR, lastTurnEndAt: HOUR } };
    expect(evaluateIdleStopGuard(input).allow).toBe(true);
    const retention: RetentionRecord = { policy: { mode: 'keep-alive' }, configuredAt: HOUR, revision: 1 };
    expect(evaluateIdleStopGuard({ ...input, retention })).toMatchObject({ allow: false, guard: 'session-retention' });
    expect(evaluateIdleStopGuard({ ...input, retention: { ...retention, policy: { mode: 'default' } } }).allow).toBe(true);
    expect(evaluateIdleStopGuard({ ...input, retention: { ...retention, policy: { mode: 'idle', durationMs: HOUR } } }).allow).toBe(true);
    // Real runtime-report silence still follows the existing zombie recovery policy.
    expect(evaluateIdleStopGuard({ ...input, retention, runtime: { ...input.runtime, updatedAt: HOUR } }).allow).toBe(true);
    expect(evaluateIdleStopGuard({ ...input, retention, runtime: { ...input.runtime, thinking: true, updatedAt: HOUR } }).allow).toBe(false);
  });
  it('does not reinterpret manual or budget stops as idle protection', () => {
    expect(resolveStopSessionMode({ source: 'archive', mode: 'force' })).toBe('force');
    expect(resolveStopSessionMode({ source: 'session-idle-reaper', reason: 'trial-budget-exhausted' })).toBe('if-not-busy');
    expect(evaluateBusyOnlyStopGuard({ runtime: { thinking: false, hasOpenToolCall: false, updatedAt: 0 } }).allow).toBe(true);
  });
});


it('keeps a real waiting child alive through a server reap and delivers its follow-up on the same PID', async () => {
  const h = fixture(), now = 10 * HOUR;
  const createChild = () => spawn(process.execPath, ['-e', "process.stdin.on('data', x => process.stdout.write('review:' + x)); process.stdout.write('ready\\n')"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = createChild(), ordinary = createChild();
  try {
    await Promise.all([once(waiting.stdout, 'data'), once(ordinary.stdout, 'data')]);
    const runtime = { thinking: false, hasOpenToolCall: false, updatedAt: now, lastTurnEndAt: HOUR, lastUserInteractionAt: HOUR };
    const children: TrackedSession[] = [waiting, ordinary].map((child, index) => ({ pid: child.pid!, startedBy: 'daemon', happySessionId: index ? 'ordinary' : 'waiting', runtime,
      happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never }));
    const service = createSessionRetention({ home: h.home, children: () => children, now: () => now });
    await service.set({ sessionId: 'waiting', policy: { mode: 'keep-alive' }, expectedRevision: 0 });
    const ordinaryExit = once(ordinary, 'exit');
    const result = await runDaemonSessionIdleReaperTick({ now, machineId: 'm', serverUrl: 'http://fixture', credentialsToken: 'fixture', trackedSessions: children,
      sessionStartTimes: new Map(children.map(child => [child.pid, HOUR])),
      postCandidates: async () => ({ checkedAt: now, candidates: children.map(child => ({ sessionId: child.happySessionId!, projectId: 'p', machineId: 'm', lastActiveAt: HOUR, idleMs: 9 * HOUR, reason: 'turn-end' as const })) }),
      stopSession: id => {
        const child = children.find(row => row.happySessionId === id)!;
        const decision = evaluateIdleStopGuard({ now, startedBy: 'daemon', runtime: child.runtime, sessionStartedAt: HOUR, config: readIdleStopGuardConfig({}), retention: service.record(id) });
        if (!decision.allow) return { stopped: false, reason: 'active', guard: decision.guard, activity: decision.activity };
        process.kill(child.pid, 'SIGTERM'); return { stopped: true };
      },
    });
    expect(result).toMatchObject({ stoppedSessions: 1, skippedActiveSessions: 1 });
    await ordinaryExit;
    expect(waiting.exitCode).toBeNull(); expect(waiting.signalCode).toBeNull();
    const answer = once(waiting.stdout, 'data'); waiting.stdin.write('next-review');
    expect(String((await answer)[0])).toBe('review:next-review');
    expect(children[0].pid).toBe(waiting.pid);
    expect(await createSessionRetention({ home: h.home, children: () => children, now: () => now }).get({ sessionId: 'waiting' })).toMatchObject({ policy: { mode: 'keep-alive' } });
  } finally {
    for (const child of [waiting, ordinary]) {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    }
  }
}, 10000);
