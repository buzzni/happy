import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
  DEFAULT_IDLE_STOP_HARD_CAP_MS,
  DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS,
  DEFAULT_IDLE_STOP_PRESENCE_STALE_MS,
  DEFAULT_IDLE_STOP_RECENT_INTERACTION_MS,
  DEFAULT_SESSION_EMPTY_REAPER_MS,
  DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX,
  DEFAULT_SESSION_TURN_END_REAPER_MS,
  buildDaemonSessionIdleReaperRequest,
  evaluateIdleStopGuard,
  isPolicyStopSource,
  readDaemonSessionIdleReaperConfig,
  readEmptySessionReaperMs,
  readIdleStopGuardConfig,
  restoreSessionStartTimes,
  resolveStopSessionMode,
  runDaemonSessionIdleReaperTick,
  sweepEmptySessions,
  sweepZombieSessions,
  type IdleStopGuardConfig,
} from './sessionIdleReaper';
import type { SessionRuntimeState, TrackedSession } from './types';

function tracked(overrides: Partial<TrackedSession>): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 100,
    ...overrides,
  };
}

describe('buildDaemonSessionIdleReaperRequest', () => {
  it('includes only tracked claude/codex sessions with start time fallback lastActiveAt', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'session-claude',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
        }),
        tracked({
          pid: 101,
          happySessionId: 'session-codex',
          happySessionMetadataFromLocalWebhook: { flavor: 'codex' } as never,
        }),
        tracked({
          pid: 102,
          happySessionId: 'session-gemini',
          happySessionMetadataFromLocalWebhook: { flavor: 'gemini' } as never,
        }),
        tracked({ pid: 103 }),
      ],
    });

    expect(request).toEqual({
      machineId: 'machine-1',
      sessions: [
        {
          sessionId: 'session-claude',
          agent: 'claude',
          active: true,
          thinking: false,
          hasOpenToolCall: false,
          pendingUserInput: false,
          lastActiveAt: 1_000,
        },
        {
          sessionId: 'session-codex',
          agent: 'codex',
          active: true,
          thinking: false,
          hasOpenToolCall: false,
          pendingUserInput: false,
          lastActiveAt: 10_000,
        },
      ],
    });
  });

  it('includes runtime busy state reported by tracked sessions', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'session-claude',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
          runtime: {
            thinking: true,
            hasOpenToolCall: true,
            updatedAt: 9_000,
          },
        }),
      ],
    });

    expect(request.sessions).toEqual([
      {
        sessionId: 'session-claude',
        agent: 'claude',
        active: true,
        thinking: true,
        hasOpenToolCall: true,
        pendingUserInput: false,
        lastActiveAt: 1_000,
      },
    ]);
  });

  it('forwards user-activity signals so the server can select candidates from real activity', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'session-claude',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
          runtime: {
            thinking: false,
            hasOpenToolCall: false,
            pendingUserInput: true,
            lastUserInteractionAt: 8_500,
            mode: 'local',
            updatedAt: 9_000,
          },
        }),
      ],
    });

    expect(request.sessions).toEqual([
      {
        sessionId: 'session-claude',
        agent: 'claude',
        active: true,
        thinking: false,
        hasOpenToolCall: false,
        pendingUserInput: true,
        lastUserInteractionAt: 8_500,
        mode: 'local',
        lastActiveAt: 1_000,
      },
    ]);
  });

  it('does not treat fresh runtime keep-alive as user activity', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'session-claude',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
          runtime: {
            thinking: false,
            hasOpenToolCall: false,
            updatedAt: 9_000,
          },
        }),
      ],
    });

    expect(request.sessions).toEqual([
      {
        sessionId: 'session-claude',
        agent: 'claude',
        active: true,
        thinking: false,
        hasOpenToolCall: false,
        pendingUserInput: false,
        lastActiveAt: 1_000,
      },
    ]);
  });

  it('passes optional idle and presence thresholds through to the server request', () => {
    expect(buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      idleAfterMs: 123,
      presenceStaleMs: 456,
      turnEndReaperMs: 789,
      sessionStartTimes: new Map(),
      trackedSessions: [],
    })).toEqual({
      machineId: 'machine-1',
      idleAfterMs: 123,
      presenceStaleMs: 456,
      turnEndReaperMs: 789,
      sessions: [],
    });
  });

  it('forwards turn-end and background-job signals for the turn-end reap', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000], [101, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'done',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
          runtime: { thinking: false, hasOpenToolCall: false, lastTurnEndAt: 7_000, updatedAt: 9_000 },
        }),
        tracked({
          pid: 101,
          happySessionId: 'bg',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
          runtime: { thinking: false, hasOpenToolCall: false, lastTurnEndAt: 7_000, launchedBackgroundJob: true, updatedAt: 9_000 },
        }),
      ],
    });

    expect(request.sessions).toEqual([
      expect.objectContaining({ sessionId: 'done', lastTurnEndAt: 7_000 }),
      expect.objectContaining({ sessionId: 'bg', lastTurnEndAt: 7_000, launchedBackgroundJob: true }),
    ]);
    // The background-job session must NOT carry the flag when absent.
    expect(request.sessions[0]).not.toHaveProperty('launchedBackgroundJob');
  });
});

describe('readDaemonSessionIdleReaperConfig', () => {
  it('defaults the idle cut to 24 hours and the turn-end reap to 1 hour', () => {
    expect(DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_SESSION_TURN_END_REAPER_MS).toBe(60 * 60 * 1000);
    expect(readDaemonSessionIdleReaperConfig({})).toEqual({
      disabled: false,
      idleAfterMs: DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
      turnEndReaperMs: DEFAULT_SESSION_TURN_END_REAPER_MS,
      batchMax: DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX,
    });
  });

  it('allows env to override the per-tick stop batch cap', () => {
    expect(readDaemonSessionIdleReaperConfig({
      HAPPY_DAEMON_SESSION_IDLE_REAPER_BATCH_MAX: '25',
    })).toMatchObject({
      batchMax: 25,
    });
  });

  it('ignores a batch cap that would stop nothing, rather than silently disabling cleanup', () => {
    // A cap of 0 (or negative/garbage) would make every tick a no-op — a
    // silent, total disabling of the reaper. Use the dedicated
    // HAPPY_DAEMON_SESSION_IDLE_REAPER_DISABLED knob for that instead.
    for (const value of ['0', '-1', 'abc', '']) {
      expect(readDaemonSessionIdleReaperConfig({
        HAPPY_DAEMON_SESSION_IDLE_REAPER_BATCH_MAX: value,
      })).toMatchObject({ batchMax: DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX });
    }
    // Fractional counts round down to a whole number of sessions.
    expect(readDaemonSessionIdleReaperConfig({
      HAPPY_DAEMON_SESSION_IDLE_REAPER_BATCH_MAX: '2.7',
    })).toMatchObject({ batchMax: 2 });
  });

  it('allows env to override the idle threshold', () => {
    expect(readDaemonSessionIdleReaperConfig({
      HAPPY_DAEMON_SESSION_IDLE_REAPER_AFTER_MS: '2500',
    })).toMatchObject({
      idleAfterMs: 2500,
    });
  });

  it('overrides the turn-end reap and disables it when set to 0', () => {
    expect(readDaemonSessionIdleReaperConfig({
      HAPPY_DAEMON_SESSION_TURN_END_REAPER_MS: '900000',
    })).toMatchObject({ turnEndReaperMs: 900000 });
    // 0 disables the turn-end reap — the field is omitted so the absolute cut
    // is the only cleanup threshold.
    expect(readDaemonSessionIdleReaperConfig({
      HAPPY_DAEMON_SESSION_TURN_END_REAPER_MS: '0',
    })).not.toHaveProperty('turnEndReaperMs');
  });
});

describe('restoreSessionStartTimes', () => {
  it('restores persisted start time and uses now only for newly discovered sessions', () => {
    expect(restoreSessionStartTimes({
      trackedSessions: [tracked({ pid: 100 }), tracked({ pid: 101 })],
      persistedSessions: [{ pid: 100, startedAt: 1_000 }],
      now: 10_000,
    })).toEqual(new Map([
      [100, 1_000],
      [101, 10_000],
    ]));
  });
});

describe('runDaemonSessionIdleReaperTick', () => {
  it('stops only locally tracked server candidates and treats duplicates as no-op', async () => {
    const live = new Set(['session-1']);
    const stopSession = vi.fn((sessionId: string) =>
      live.delete(sessionId)
        ? { stopped: true as const }
        : { stopped: false as const, reason: 'not-found' as const });
    const postCandidates = vi.fn(async () => ({
      checkedAt: 20_000,
      candidates: [
        { sessionId: 'session-1', projectId: 'project-1', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
        { sessionId: 'session-1', projectId: 'project-1', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
        { sessionId: 'missing', projectId: 'project-1', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
      ],
    }));

    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      idleAfterMs: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [tracked({
        pid: 100,
        happySessionId: 'session-1',
        runtime: { thinking: true, hasOpenToolCall: false, updatedAt: 19_000 },
      })],
      stopSession,
      postCandidates,
    });

    expect(postCandidates).toHaveBeenCalledTimes(1);
    expect(postCandidates).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        sessions: [
          expect.objectContaining({
            sessionId: 'session-1',
            thinking: true,
            hasOpenToolCall: false,
          }),
        ],
      }),
    }));
    expect(stopSession).toHaveBeenCalledTimes(3);
    expect(stopSession).toHaveBeenCalledWith('session-1', { source: 'session-idle-reaper', reason: 'absolute-idle-cut', mode: 'if-idle' });
    expect(result).toEqual({
      requestedSessions: 1,
      candidateSessions: 3,
      stoppedSessions: 1,
      skippedActiveSessions: 0,
      noopSessions: 2,
      deferredSessions: 0,
    });
  });

  it('counts guard refusals separately from no-ops', async () => {
    const stopSession = vi.fn((sessionId: string) => {
      if (sessionId === 'busy') {
        return { stopped: false as const, reason: 'active' as const, guard: 'thinking', activity: { thinking: true, hasOpenToolCall: false, pendingUserInput: false } };
      }
      if (sessionId === 'gone') {
        return { stopped: false as const, reason: 'not-found' as const };
      }
      return { stopped: true as const };
    });

    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      idleAfterMs: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [tracked({ pid: 100, happySessionId: 'ok' })],
      stopSession,
      postCandidates: vi.fn(async () => ({
        checkedAt: 20_000,
        candidates: [
          { sessionId: 'ok', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
          { sessionId: 'busy', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
          { sessionId: 'gone', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
        ],
      })),
    });

    expect(result).toMatchObject({
      stoppedSessions: 1,
      skippedActiveSessions: 1,
      noopSessions: 1,
    });
  });

  it('passes the server-supplied reason through to stopSession for observability', async () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      idleAfterMs: 24 * 60 * 60 * 1000,
      sessionStartTimes: new Map([[100, 1_000], [101, 1_000]]),
      trackedSessions: [
        tracked({ pid: 100, happySessionId: 'te' }),
        tracked({ pid: 101, happySessionId: 'legacy' }),
      ],
      stopSession,
      postCandidates: vi.fn(async () => ({
        checkedAt: 20_000,
        candidates: [
          { sessionId: 'te', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 5_000, reason: 'turn-end' as const },
          // A legacy server omits reason → logged as the absolute cut.
          { sessionId: 'legacy', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 99_000 },
        ],
      })),
    });

    expect(stopSession).toHaveBeenNthCalledWith(1, 'te', { source: 'session-idle-reaper', reason: 'turn-end', mode: 'if-idle' });
    expect(stopSession).toHaveBeenNthCalledWith(2, 'legacy', { source: 'session-idle-reaper', reason: 'absolute-idle-cut', mode: 'if-idle' });
  });

  it('caps the number of sessions stopped per tick, deferring the rest to the next tick', async () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const logDebug = vi.fn();

    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      idleAfterMs: 10_000,
      batchMax: 2,
      sessionStartTimes: new Map([[100, 1_000], [101, 1_000], [102, 1_000]]),
      trackedSessions: [
        tracked({ pid: 100, happySessionId: 'a' }),
        tracked({ pid: 101, happySessionId: 'b' }),
        tracked({ pid: 102, happySessionId: 'c' }),
      ],
      stopSession,
      logDebug,
      postCandidates: vi.fn(async () => ({
        checkedAt: 20_000,
        candidates: [
          { sessionId: 'a', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
          { sessionId: 'b', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
          { sessionId: 'c', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
        ],
      })),
    });

    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledWith('a', expect.anything());
    expect(stopSession).toHaveBeenCalledWith('b', expect.anything());
    expect(result).toEqual({
      requestedSessions: 3,
      candidateSessions: 3,
      stoppedSessions: 2,
      skippedActiveSessions: 0,
      noopSessions: 0,
      deferredSessions: 1,
    });
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('deferred=1'));
  });

  it('does not let guard-refused candidates consume the stop budget', async () => {
    // The server cannot see local guard denials, so it keeps returning the
    // same refused candidates every tick. If the cap counted attempts rather
    // than actual stops, a block of permanently-refused candidates at the head
    // of the list would starve every reapable session behind them forever.
    const stopSession = vi.fn((sessionId: string) =>
      sessionId.startsWith('busy')
        ? { stopped: false as const, reason: 'active' as const, guard: 'recent-user-interaction', activity: { thinking: false, hasOpenToolCall: false, pendingUserInput: false } }
        : { stopped: true as const });

    const candidateIds = ['busy-1', 'busy-2', 'busy-3', 'reapable-1', 'reapable-2'];
    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      idleAfterMs: 10_000,
      batchMax: 2,
      sessionStartTimes: new Map(candidateIds.map((_, i) => [100 + i, 1_000])),
      trackedSessions: candidateIds.map((id, i) => tracked({ pid: 100 + i, happySessionId: id })),
      stopSession,
      postCandidates: vi.fn(async () => ({
        checkedAt: 20_000,
        candidates: candidateIds.map((sessionId) => ({
          sessionId, projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000,
        })),
      })),
    });

    expect(stopSession).toHaveBeenCalledWith('reapable-1', expect.anything());
    expect(stopSession).toHaveBeenCalledWith('reapable-2', expect.anything());
    expect(result).toMatchObject({
      stoppedSessions: 2,
      skippedActiveSessions: 3,
      deferredSessions: 0,
    });
  });

  it('does not stop sessions when the candidate request fails', async () => {
    const stopSession = vi.fn();
    const logDebug = vi.fn();

    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [tracked({ pid: 100, happySessionId: 'session-1' })],
      stopSession,
      logDebug,
      postCandidates: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    expect(stopSession).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('network down'));
    expect(result).toEqual({
      requestedSessions: 1,
      candidateSessions: 0,
      stoppedSessions: 0,
      skippedActiveSessions: 0,
      noopSessions: 0,
      deferredSessions: 0,
    });
  });
});

describe('sweepZombieSessions', () => {
  const now = 10_000_000;
  const silenceMs = 2 * 60 * 60 * 1000;

  it('stops only sessions whose runtime has been silent past the threshold', () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const stopped = sweepZombieSessions({
      trackedSessions: [
        tracked({ pid: 100, happySessionId: 'silent', runtime: { thinking: false, hasOpenToolCall: false, updatedAt: now - silenceMs - 1 } }),
        tracked({ pid: 101, happySessionId: 'fresh', runtime: { thinking: false, hasOpenToolCall: false, updatedAt: now - 1_000 } }),
      ],
      sessionStartTimes: new Map(),
      daemonStartedAt: now - 10 * silenceMs,
      stopSession,
      now,
      silenceMs,
    });

    expect(stopped).toBe(1);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith('silent', { source: 'session-zombie-sweep', reason: 'runtime-silent', mode: 'if-idle' });
  });

  it('measures never-reported sessions from daemon start so restarts get a grace window', () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const stopped = sweepZombieSessions({
      trackedSessions: [tracked({ pid: 100, happySessionId: 'recovered' })],
      sessionStartTimes: new Map([[100, now - 100 * silenceMs]]),
      daemonStartedAt: now - 60_000,
      stopSession,
      now,
      silenceMs,
    });

    expect(stopped).toBe(0);
    expect(stopSession).not.toHaveBeenCalled();
  });
});

describe('sweepEmptySessions', () => {
  const now = 10_000_000;
  const emptyReaperMs = 15 * 60 * 1000;
  const idleRuntime = (updatedAt: number): SessionRuntimeState => ({
    thinking: false,
    hasOpenToolCall: false,
    pendingUserInput: false,
    mode: 'remote',
    updatedAt,
  });

  it('stops a never-used session older than the threshold with if-idle semantics', () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const stopped = sweepEmptySessions({
      trackedSessions: [tracked({ pid: 100, happySessionId: 'empty', runtime: idleRuntime(now - 1_000) })],
      sessionStartTimes: new Map([[100, now - emptyReaperMs - 1]]),
      stopSession,
      now,
      emptyReaperMs,
    });

    expect(stopped).toBe(1);
    expect(stopSession).toHaveBeenCalledWith('empty', { source: 'session-empty-reaper', reason: 'never-used', mode: 'if-idle' });
  });

  it('caps how many never-used sessions it stops per sweep', () => {
    // The empty reaper runs on the same tick as (and before) the idle reaper,
    // and daemon-spawned sessions that were never used are exactly what the
    // local-session guard used to protect. Without its own cap, the first tick
    // after that guard is fixed SIGTERMs the whole backlog at once, bypassing
    // the idle reaper's batch cap entirely.
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const ids = ['e1', 'e2', 'e3', 'e4', 'e5'];
    const stopped = sweepEmptySessions({
      trackedSessions: ids.map((id, i) => tracked({ pid: 100 + i, happySessionId: id, runtime: idleRuntime(now - 1_000) })),
      sessionStartTimes: new Map(ids.map((_, i) => [100 + i, now - emptyReaperMs - 1])),
      stopSession,
      now,
      emptyReaperMs,
      batchMax: 2,
    });

    expect(stopped).toBe(2);
    expect(stopSession).toHaveBeenCalledTimes(2);
  });

  it('leaves a session younger than the threshold alone', () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const stopped = sweepEmptySessions({
      trackedSessions: [tracked({ pid: 100, happySessionId: 'young', runtime: idleRuntime(now - 1_000) })],
      sessionStartTimes: new Map([[100, now - emptyReaperMs + 60_000]]),
      stopSession,
      now,
      emptyReaperMs,
    });

    expect(stopped).toBe(0);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('never reaps a session that has any usage history', () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const oldStart = new Map([[100, now - emptyReaperMs - 1]]);
    const cases: SessionRuntimeState[] = [
      { ...idleRuntime(now - 1_000), lastUserInteractionAt: now - 60_000 },
      { ...idleRuntime(now - 1_000), lastTurnEndAt: now - 60_000 },
      { ...idleRuntime(now - 1_000), launchedBackgroundJob: true },
      { ...idleRuntime(now - 1_000), thinking: true },
      { ...idleRuntime(now - 1_000), hasOpenToolCall: true },
      { ...idleRuntime(now - 1_000), pendingUserInput: true },
    ];
    for (const runtime of cases) {
      const stopped = sweepEmptySessions({
        trackedSessions: [tracked({ pid: 100, happySessionId: 's', runtime })],
        sessionStartTimes: oldStart,
        stopSession,
        now,
        emptyReaperMs,
      });
      expect(stopped).toBe(0);
    }
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('leaves a session with no runtime report to the guard/absolute cut', () => {
    const stopSession = vi.fn(() => ({ stopped: true as const }));
    const stopped = sweepEmptySessions({
      trackedSessions: [tracked({ pid: 100, happySessionId: 'norep' })],
      sessionStartTimes: new Map([[100, now - emptyReaperMs - 1]]),
      stopSession,
      now,
      emptyReaperMs,
    });

    expect(stopped).toBe(0);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('does not count a session the guard refuses to stop', () => {
    const stopSession = vi.fn(() => ({ stopped: false as const, reason: 'active' as const, guard: 'local-session', activity: { thinking: false, hasOpenToolCall: false, pendingUserInput: false } }));
    const stopped = sweepEmptySessions({
      trackedSessions: [tracked({ pid: 100, happySessionId: 'guarded', runtime: idleRuntime(now - 1_000) })],
      sessionStartTimes: new Map([[100, now - emptyReaperMs - 1]]),
      stopSession,
      now,
      emptyReaperMs,
    });

    expect(stopped).toBe(0);
    expect(stopSession).toHaveBeenCalledTimes(1);
  });
});

describe('readEmptySessionReaperMs', () => {
  it('defaults to 15 minutes', () => {
    expect(readEmptySessionReaperMs({})).toBe(DEFAULT_SESSION_EMPTY_REAPER_MS);
  });

  it('honors a positive override', () => {
    expect(readEmptySessionReaperMs({ HAPPY_DAEMON_SESSION_EMPTY_REAPER_MS: '600000' })).toBe(600_000);
  });

  it('treats 0 as disabled', () => {
    expect(readEmptySessionReaperMs({ HAPPY_DAEMON_SESSION_EMPTY_REAPER_MS: '0' })).toBeUndefined();
  });

  it('falls back to the default on invalid input', () => {
    expect(readEmptySessionReaperMs({ HAPPY_DAEMON_SESSION_EMPTY_REAPER_MS: 'abc' })).toBe(DEFAULT_SESSION_EMPTY_REAPER_MS);
  });
});

describe('isPolicyStopSource / resolveStopSessionMode', () => {
  it('treats idle/cleanup policy sources as policy stops', () => {
    expect(isPolicyStopSource('project-session-idle-stop')).toBe(true);
    expect(isPolicyStopSource('session-idle-reaper')).toBe(true);
    expect(isPolicyStopSource('some-idle-thing')).toBe(true);
    expect(isPolicyStopSource(undefined)).toBe(false);
    expect(isPolicyStopSource('user')).toBe(false);
    expect(isPolicyStopSource('mobile-app')).toBe(false);
  });

  it('defaults to force, infers if-idle from policy source, and honors explicit mode', () => {
    expect(resolveStopSessionMode()).toBe('force');
    expect(resolveStopSessionMode({})).toBe('force');
    expect(resolveStopSessionMode({ source: 'mobile-app' })).toBe('force');
    // A policy source with no explicit mode must never get force semantics.
    expect(resolveStopSessionMode({ source: 'project-session-idle-stop' })).toBe('if-idle');
    // Explicit mode always wins.
    expect(resolveStopSessionMode({ source: 'project-session-idle-stop', mode: 'force' })).toBe('force');
    expect(resolveStopSessionMode({ source: 'user', mode: 'if-idle' })).toBe('if-idle');
  });
});

describe('readIdleStopGuardConfig', () => {
  it('applies conservative defaults and protects local sessions by default', () => {
    expect(readIdleStopGuardConfig({})).toEqual({
      recentInteractionMs: DEFAULT_IDLE_STOP_RECENT_INTERACTION_MS,
      minSessionAgeMs: DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS,
      hardCapMs: DEFAULT_IDLE_STOP_HARD_CAP_MS,
      presenceStaleMs: DEFAULT_IDLE_STOP_PRESENCE_STALE_MS,
      protectLocalSessions: true,
    });
  });

  it('reads overrides and lets local protection be turned off explicitly', () => {
    expect(readIdleStopGuardConfig({
      HAPPY_DAEMON_SESSION_IDLE_RECENT_INTERACTION_MS: '500',
      HAPPY_DAEMON_SESSION_IDLE_MIN_AGE_MS: '1000',
      HAPPY_DAEMON_SESSION_IDLE_HARD_CAP_MS: '2000',
      HAPPY_DAEMON_SESSION_IDLE_PRESENCE_STALE_MS: '3000',
      HAPPY_DAEMON_SESSION_IDLE_PROTECT_LOCAL: 'false',
    })).toMatchObject({
      recentInteractionMs: 500,
      minSessionAgeMs: 1000,
      hardCapMs: 2000,
      presenceStaleMs: 3000,
      protectLocalSessions: false,
    });
  });
});

describe('evaluateIdleStopGuard', () => {
  const config: IdleStopGuardConfig = {
    recentInteractionMs: 30 * 60 * 1000,
    minSessionAgeMs: 10 * 60 * 1000,
    hardCapMs: 2 * 60 * 60 * 1000,
    presenceStaleMs: 5 * 60 * 1000,
    protectLocalSessions: true,
  };

  const now = 10_000_000;
  const old = now - config.hardCapMs - 1; // ancient: past the zombie hard cap
  const withinCap = now - 20 * 60 * 1000; // past min age (10m) but within hard cap (2h)

  function runtime(overrides: Partial<SessionRuntimeState>): SessionRuntimeState {
    return { thinking: false, hasOpenToolCall: false, updatedAt: now, ...overrides };
  }

  it('allows a stop for a quiet, old-enough session with a fresh runtime report', () => {
    expect(evaluateIdleStopGuard({
      runtime: runtime({}),
      sessionStartedAt: withinCap,
      now,
      config,
    })).toEqual({ allow: true });
  });

  it.each([
    ['thinking', runtime({ thinking: true })],
    ['open-tool-call', runtime({ hasOpenToolCall: true })],
    ['pending-user-input', runtime({ pendingUserInput: true })],
  ] as const)('denies when %s (hard block, even for an old session)', (guard, rt) => {
    expect(evaluateIdleStopGuard({ runtime: rt, sessionStartedAt: old, now, config }))
      .toEqual({ allow: false, guard, activity: expect.any(Object) });
  });

  it('denies a session the user interacted with recently', () => {
    const decision = evaluateIdleStopGuard({
      runtime: runtime({ lastUserInteractionAt: now - 60_000 }),
      sessionStartedAt: withinCap,
      now,
      config,
    });
    expect(decision).toMatchObject({ allow: false, guard: 'recent-user-interaction' });
  });

  it('denies a freshly spawned session below the minimum age', () => {
    const decision = evaluateIdleStopGuard({
      runtime: runtime({}),
      sessionStartedAt: now - 60_000,
      now,
      config,
    });
    expect(decision).toMatchObject({ allow: false, guard: 'min-session-age' });
  });

  it('denies a session with an attached local terminal when protection is on', () => {
    const decision = evaluateIdleStopGuard({
      runtime: runtime({ mode: 'local' }),
      sessionStartedAt: withinCap,
      now,
      config,
    });
    expect(decision).toMatchObject({ allow: false, guard: 'local-session' });
  });

  it('does not apply local protection to a daemon-spawned session reporting mode=local', () => {
    // Daemon-spawned sessions are always started with --happy-starting-mode
    // remote (runClaude.ts refuses daemon+local at spawn time), so a
    // daemon-spawned session can never have a real attached terminal. A
    // 'local' report from one is a client-side reporting bug, not a real
    // terminal — the local-session guard must not treat it as one.
    const decision = evaluateIdleStopGuard({
      runtime: runtime({ mode: 'local' }),
      sessionStartedAt: withinCap,
      startedBy: 'daemon',
      now,
      config,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('denies when the runtime report is missing or stale within the hard cap', () => {
    expect(evaluateIdleStopGuard({
      runtime: undefined,
      sessionStartedAt: now - 20 * 60 * 1000,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'stale-runtime' });

    expect(evaluateIdleStopGuard({
      runtime: runtime({ updatedAt: now - config.presenceStaleMs - 1 }),
      sessionStartedAt: now - 20 * 60 * 1000,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'stale-runtime' });
  });

  it('allows cleanup when the runtime has been silent past the hard cap', () => {
    // Local + stale runtime, but the runtime stopped reporting hardCapMs ago —
    // a live session reports every keepalive, so this is a zombie.
    expect(evaluateIdleStopGuard({
      runtime: runtime({ mode: 'local', updatedAt: now - config.hardCapMs - 1 }),
      sessionStartedAt: now - 3 * config.hardCapMs,
      now,
      config,
    })).toEqual({ allow: true });

    // Never reported at all, and both the session and this daemon have been up
    // past the hard cap — nothing left to wait for.
    expect(evaluateIdleStopGuard({
      runtime: undefined,
      sessionStartedAt: now - 3 * config.hardCapMs,
      daemonStartedAt: now - config.hardCapMs - 1,
      now,
      config,
    })).toEqual({ allow: true });
  });

  it('denies an ancient session the user interacted with recently', () => {
    // Process age is way past the hard cap, but the user touched it a minute
    // ago — cleanup must never win over live user activity (2026-07-16 사고:
    // age-based zombie hatch killed sessions users were actively chatting in).
    expect(evaluateIdleStopGuard({
      runtime: runtime({ lastUserInteractionAt: now - 60_000, updatedAt: now - config.presenceStaleMs - 1 }),
      sessionStartedAt: now - config.hardCapMs - 1,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'recent-user-interaction' });
  });

  it('gives recovered sessions a fresh report window after a daemon restart', () => {
    // Session process is days old but this daemon just started and the session
    // has not reported yet — silence is measured from daemon start, so the
    // first reaper tick cannot mass-kill recovered sessions.
    expect(evaluateIdleStopGuard({
      runtime: undefined,
      sessionStartedAt: now - 3 * config.hardCapMs,
      daemonStartedAt: now - 60_000,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'stale-runtime' });
  });

  it('allows a quiet old session that reports fresh runtime and no recent interaction', () => {
    expect(evaluateIdleStopGuard({
      runtime: runtime({ lastUserInteractionAt: now - config.recentInteractionMs - 1 }),
      sessionStartedAt: now - config.hardCapMs - 1,
      now,
      config,
    })).toEqual({ allow: true });
  });

  it('still hard-blocks an ancient session that is actively working', () => {
    expect(evaluateIdleStopGuard({
      runtime: runtime({ hasOpenToolCall: true }),
      sessionStartedAt: now - config.hardCapMs - 1,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'open-tool-call' });
  });
});
