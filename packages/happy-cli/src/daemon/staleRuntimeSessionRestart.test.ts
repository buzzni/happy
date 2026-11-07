import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STALE_RUNTIME_RESTART_QUIET_MS,
  isOlderRuntimeVersion,
  readStaleRuntimeRestartConfig,
  sweepStaleRuntimeSessions,
} from './staleRuntimeSessionRestart';
import type { SessionRuntimeState, TrackedSession } from './types';

const DAEMON_VERSION = '1.1.10-aplus.395';
const now = 10_000_000;
const quietMs = DEFAULT_STALE_RUNTIME_RESTART_QUIET_MS;

function idleRuntime(overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  return {
    thinking: false,
    hasOpenToolCall: false,
    pendingUserInput: false,
    mode: 'remote',
    lastUserInteractionAt: now - quietMs - 5_000,
    lastTurnEndAt: now - quietMs - 1_000,
    updatedAt: now - 1_000,
    ...overrides,
  };
}

function tracked(overrides: Partial<TrackedSession> & { version?: string } = {}): TrackedSession {
  const { version = '1.1.10-aplus.388', ...rest } = overrides;
  return {
    startedBy: 'daemon',
    pid: 100,
    happySessionId: 'old-session',
    happySessionMetadataFromLocalWebhook: { flavor: 'claude', version } as never,
    runtime: idleRuntime(),
    ...rest,
  };
}

function sweep(trackedSessions: TrackedSession[], extra: Partial<Parameters<typeof sweepStaleRuntimeSessions>[0]> = {}) {
  const stopSession = vi.fn(() => ({ stopped: true as const }));
  const stopped = sweepStaleRuntimeSessions({
    trackedSessions,
    sessionStartTimes: new Map(trackedSessions.map(session => [session.pid, now - 60 * 60 * 1000])),
    daemonVersion: DAEMON_VERSION,
    stopSession,
    now,
    ...extra,
  });
  return { stopped, stopSession };
}

describe('isOlderRuntimeVersion', () => {
  it('orders aplus builds numerically, not lexically', () => {
    expect(isOlderRuntimeVersion('1.1.10-aplus.388', '1.1.10-aplus.394')).toBe(true);
    expect(isOlderRuntimeVersion('1.1.10-aplus.99', '1.1.10-aplus.388')).toBe(true);
    expect(isOlderRuntimeVersion('1.1.9', '1.1.10-aplus.1')).toBe(true);
  });

  it('is false for the same, a newer or an unreadable version', () => {
    expect(isOlderRuntimeVersion('1.1.10-aplus.394', '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion('1.1.10-aplus.400', '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion(undefined, '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion('dev', '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion('1.1.10-aplus.388', 'dev')).toBe(false);
  });
});

describe('sweepStaleRuntimeSessions', () => {
  it('stops an idle session still running an older runtime so the next input starts the new one', () => {
    const { stopped, stopSession } = sweep([tracked()]);

    expect(stopped).toBe(1);
    // if-not-busy: a user who interacted a minute ago is exactly who needs the new runtime,
    // so the 30-minute recent-interaction floor of if-idle must not apply.
    expect(stopSession).toHaveBeenCalledWith('old-session', {
      source: 'stale-runtime-restart',
      reason: 'runtime-updated',
      mode: 'if-not-busy',
    });
  });

  it('leaves sessions that already run this runtime, a newer one, or report no version', () => {
    const { stopped, stopSession } = sweep([
      tracked({ pid: 101, happySessionId: 'current', version: DAEMON_VERSION }),
      tracked({ pid: 102, happySessionId: 'newer', version: '1.1.10-aplus.396' }),
      tracked({ pid: 103, happySessionId: 'no-version', happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never }),
      tracked({ pid: 104, happySessionId: 'no-metadata', happySessionMetadataFromLocalWebhook: undefined }),
    ]);

    expect(stopped).toBe(0);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('never interrupts work, a terminal, a background job or an unknown runtime', () => {
    const cases: Array<Partial<TrackedSession>> = [
      { runtime: idleRuntime({ thinking: true }) },
      { runtime: idleRuntime({ hasOpenToolCall: true }) },
      { runtime: idleRuntime({ pendingUserInput: true }) },
      { runtime: idleRuntime({ mode: 'local' }) },
      { runtime: idleRuntime({ launchedBackgroundJob: true }) },
      { runtime: undefined },
      // No report for longer than the presence window: state unknown, the zombie sweep owns it.
      { runtime: idleRuntime({ updatedAt: now - 6 * 60 * 1000 }) },
      { happySessionId: undefined },
    ];
    for (const overrides of cases) {
      const { stopped, stopSession } = sweep([tracked(overrides)]);
      expect(stopped, JSON.stringify(overrides)).toBe(0);
      expect(stopSession).not.toHaveBeenCalled();
    }
  });

  it('waits for a quiet period after the last turn end and the last user input', () => {
    const justEnded = sweep([tracked({ runtime: idleRuntime({ lastTurnEndAt: now - 5_000 }) })]);
    const justTyped = sweep([tracked({ runtime: idleRuntime({ lastUserInteractionAt: now - 5_000 }) })]);

    expect(justEnded.stopped).toBe(0);
    expect(justTyped.stopped).toBe(0);
  });

  it('measures quiet from session start when the session was never used', () => {
    const neverUsed = tracked({ runtime: idleRuntime({ lastUserInteractionAt: undefined, lastTurnEndAt: undefined }) });
    const fresh = sweep([neverUsed], { sessionStartTimes: new Map([[100, now - 5_000]]) });
    const old = sweep([neverUsed], { sessionStartTimes: new Map([[100, now - quietMs - 1]]) });
    const unknownStart = sweep([neverUsed], { sessionStartTimes: new Map() });

    expect(fresh.stopped).toBe(0);
    expect(old.stopped).toBe(1);
    expect(unknownStart.stopped).toBe(0);
  });

  it('respects a retention policy that keeps the session process alive', () => {
    const protectedSession = sweep([tracked()], { retentionProtects: () => true });

    expect(protectedSession.stopped).toBe(0);
    expect(protectedSession.stopSession).not.toHaveBeenCalled();
  });

  it('caps stops per sweep and counts only sessions that actually stopped', () => {
    const sessions = ['a', 'b', 'c', 'd'].map((id, i) => tracked({ pid: 200 + i, happySessionId: id }));
    const capped = sweep(sessions, { batchMax: 2 });
    expect(capped.stopped).toBe(2);
    expect(capped.stopSession).toHaveBeenCalledTimes(2);

    const refused = vi.fn(() => ({ stopped: false as const, reason: 'not-found' as const }));
    const none = sweepStaleRuntimeSessions({
      trackedSessions: [tracked()],
      sessionStartTimes: new Map(),
      daemonVersion: DAEMON_VERSION,
      stopSession: refused,
      now,
    });
    expect(none).toBe(0);
  });
});

describe('readStaleRuntimeRestartConfig', () => {
  it('is on by default with a one-minute quiet period', () => {
    expect(readStaleRuntimeRestartConfig({})).toEqual({ disabled: false, quietMs: 60_000 });
  });

  it('honours the opt-out and a quiet-period override', () => {
    expect(readStaleRuntimeRestartConfig({ HAPPY_DAEMON_STALE_RUNTIME_RESTART_DISABLED: '1' }).disabled).toBe(true);
    expect(readStaleRuntimeRestartConfig({ HAPPY_DAEMON_STALE_RUNTIME_RESTART_QUIET_MS: '300000' }).quietMs).toBe(300_000);
  });
});
