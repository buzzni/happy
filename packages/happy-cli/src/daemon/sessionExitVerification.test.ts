import { describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import {
  captureSessionProcessTree,
  deadlineAfter,
  stopSessionWithVerifiedExit,
  createProcFs,
  createProcProcessProbe,
  parseProcStat,
  waitForSnapshotExit,
  type ProcessProbe,
  type ProcessProbeResult,
  type ProcessRow,
  type ProcessTableResult,
} from './sessionExitVerification';

const SCOPE = 'session-process-tree-snapshot';

function row(pid: number, ppid: number, startToken = `${pid}00`, zombie = false): ProcessRow {
  return { pid, ppid, startToken, zombie };
}

function statLine(options: { pid: number; ppid: number; state?: string; startToken?: string; comm?: string }): string {
  // Pad so the start time lands on stat field 22.
  const filler = Array.from({ length: 12 }, () => '0').join(' ');
  return `${options.pid} (${options.comm ?? 'node'}) ${options.state ?? 'S'} ${options.ppid} `
    + `${options.pid} ${options.pid} 0 -1 0 ${filler} ${options.startToken ?? `${options.pid}00`} rest`;
}

/**
 * Probe over fixed tables. `scan` walks the script (last entry repeats) and
 * `probe` answers from the current table, which is how the observation loop
 * sees processes disappear.
 */
function scriptedProbe(script: ProcessTableResult[]): ProcessProbe {
  let index = 0;
  let current: ProcessTableResult = script[0]!;
  return {
    scan: async (deadline) => {
      if (deadline.expired()) return { status: 'expired' };
      current = script[Math.min(index++, script.length - 1)]!;
      return current;
    },
    probe: async (pid, deadline): Promise<ProcessProbeResult> => {
      if (deadline.expired()) return { status: 'expired' };
      current = script[Math.min(index++, script.length - 1)]!;
      if (current.status !== 'ok') return { status: current.status };
      const found = current.rows.find((r) => r.pid === pid);
      return found ? { status: 'alive', row: found } : { status: 'absent' };
    },
  };
}

function table(rows: ProcessRow[]): ProcessTableResult {
  return { status: 'ok', rows };
}

/** A deadline that never fires — for tests about something other than time. */
const never = () => deadlineAfter(Number.MAX_SAFE_INTEGER, () => 0);

const fastClock = () => {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  };
};

describe('parseProcStat', () => {
  it('reads state, ppid and start time past a command name containing spaces and parens', () => {
    expect(parseProcStat(4242, statLine({ pid: 4242, ppid: 4200, comm: 'node (weird) name', startToken: '987654321' })))
      .toEqual({ pid: 4242, ppid: 4200, startToken: '987654321', zombie: false });
  });

  it('marks state Z as a zombie', () => {
    expect(parseProcStat(7, statLine({ pid: 7, ppid: 1, state: 'Z' }))?.zombie).toBe(true);
  });

  it('returns null for a stat line it cannot identify', () => {
    expect(parseProcStat(1, 'garbage without parens')).toBeNull();
  });
});

describe('createProcProcessProbe', () => {
  const fs = (overrides: Partial<Parameters<typeof createProcProcessProbe>[0]>) => createProcProcessProbe({
    platform: 'linux',
    listProc: async () => ({ status: 'unreadable' }),
    readProcStat: async () => ({ status: 'unreadable' }),
    ...overrides,
  });

  it('answers unsupported off Linux instead of guessing', async () => {
    const probe = fs({
      platform: 'darwin',
      listProc: async () => { throw new Error('must not read /proc on darwin'); },
      readProcStat: async () => { throw new Error('must not read /proc on darwin'); },
    });
    await expect(probe.scan(never())).resolves.toEqual({ status: 'unsupported' });
    await expect(probe.probe(1, never())).resolves.toEqual({ status: 'unsupported' });
  });

  it('reports unreadable when /proc cannot be listed', async () => {
    await expect(fs({ listProc: async () => ({ status: 'unreadable' }) }).scan(never()))
      .resolves.toEqual({ status: 'unreadable' });
  });

  it('skips a pid that exits mid-scan but fails the scan on an unreadable one', async () => {
    const listing = { status: 'ok' as const, entries: ['1', '2', '3', 'self', 'cpuinfo'] };
    await expect(fs({
      listProc: async () => listing,
      readProcStat: async (pid) => (pid === 1
        ? { status: 'ok', content: statLine({ pid: 1, ppid: 0, startToken: '1' }) }
        : { status: 'absent' }),
    }).scan(never())).resolves.toEqual({ status: 'ok', rows: [{ pid: 1, ppid: 0, startToken: '1', zombie: false }] });

    await expect(fs({
      listProc: async () => listing,
      readProcStat: async (pid) => (pid === 2 ? { status: 'unreadable' } : { status: 'absent' }),
    }).scan(never())).resolves.toEqual({ status: 'unreadable' });
  });

  it('treats an unreadable or unparseable stat as missing evidence, never as absence', async () => {
    await expect(fs({ readProcStat: async () => ({ status: 'unreadable' }) }).probe(9, never()))
      .resolves.toEqual({ status: 'unreadable' });
    await expect(fs({ readProcStat: async () => ({ status: 'ok', content: 'truncated' }) }).probe(9, never()))
      .resolves.toEqual({ status: 'unreadable' });
    await expect(fs({ readProcStat: async () => ({ status: 'absent' }) }).probe(9, never()))
      .resolves.toEqual({ status: 'absent' });
  });

  it.runIf(process.platform === 'linux')('reads this process out of the real /proc', async () => {
    const probe = createProcProcessProbe(createProcFs());
    await expect(probe.probe(process.pid, never())).resolves.toMatchObject({ status: 'alive' });
    const scan = await probe.scan(never());
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.rows.some((r) => r.pid === process.pid)).toBe(true);
  });

  it('reports a never-used pid as absent, not unreadable, on the real filesystem', async () => {
    const probe = createProcProcessProbe(createProcFs());
    const result = await probe.probe(0x7ffffff, never());
    expect(result.status).toBe(process.platform === 'linux' ? 'absent' : 'unsupported');
  });
});

describe('captureSessionProcessTree', () => {
  it('captures the tracked root and its descendants only', async () => {
    const rows = [row(100, 1), row(200, 100), row(300, 200), row(400, 1), row(500, 400)];
    const snapshot = await captureSessionProcessTree({ rootPid: 100, probe: scriptedProbe([table(rows)]) });

    expect(snapshot.kind).toBe('captured');
    if (snapshot.kind !== 'captured') return;
    expect(snapshot.processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('reports unavailable — never exited — when the platform has no /proc', async () => {
    await expect(captureSessionProcessTree({ rootPid: 100, probe: scriptedProbe([{ status: 'unsupported' }]) }))
      .resolves.toEqual({ kind: 'unavailable', detail: 'platform-unsupported' });
  });

  it('reports unavailable when the process table cannot be read', async () => {
    await expect(captureSessionProcessTree({ rootPid: 100, probe: scriptedProbe([{ status: 'unreadable' }]) }))
      .resolves.toEqual({ kind: 'unavailable', detail: 'process-table-unreadable' });
  });

  it('reports unavailable when the tracked root is already gone, because its children are unreachable', async () => {
    await expect(captureSessionProcessTree({ rootPid: 100, probe: scriptedProbe([table([row(1, 0), row(200, 1)])]) }))
      .resolves.toEqual({ kind: 'unavailable', detail: 'root-process-absent' });
  });

  it('rejects a snapshot whose root was recycled during the scan', async () => {
    await expect(captureSessionProcessTree({
      rootPid: 100,
      // scan sees the original root; the recheck finds a different process on the same pid.
      probe: scriptedProbe([table([row(100, 1, 'start-a'), row(200, 100)]), table([row(100, 1, 'start-b')])]),
    })).resolves.toEqual({ kind: 'unavailable', detail: 'root-identity-changed' });
  });

  it('rejects a snapshot whose root exited during the scan', async () => {
    await expect(captureSessionProcessTree({
      rootPid: 100,
      probe: scriptedProbe([table([row(100, 1), row(200, 100)]), table([row(200, 1)])]),
    })).resolves.toEqual({ kind: 'unavailable', detail: 'root-process-absent' });
  });

  it('refuses to snapshot an unbounded tree', async () => {
    const rows = [row(100, 1)];
    for (let pid = 101; pid < 800; pid++) rows.push(row(pid, 100));
    await expect(captureSessionProcessTree({ rootPid: 100, probe: scriptedProbe([table(rows)]) }))
      .resolves.toEqual({ kind: 'unavailable', detail: 'snapshot-too-large' });
  });

  it('gives up on a scan that outran its budget instead of trusting a stale tree', async () => {
    // Every read succeeds and every read is slow: the walk must stop at the
    // deadline rather than finish a table of thousands.
    let clock = 0;
    let reads = 0;
    const probe = createProcProcessProbe({
      platform: 'linux',
      listProc: async () => ({ status: 'ok', entries: Array.from({ length: 3_000 }, (_, i) => `${i + 1}`) }),
      readProcStat: async (pid) => {
        reads++;
        clock += 200;
        return { status: 'ok', content: statLine({ pid, ppid: 1 }) };
      },
    });

    await expect(captureSessionProcessTree({ rootPid: 100, probe, budgetMs: 1_500, now: () => clock }))
      .resolves.toEqual({ kind: 'unavailable', detail: 'snapshot-budget-exceeded' });
    // 1_500 ms of budget at 200 ms per read, plus the one read already in
    // flight when the deadline passed.
    expect(reads).toBeLessThanOrEqual(9);
  });
});

describe('waitForSnapshotExit', () => {
  it('reports exited once every captured process is gone', async () => {
    const processes = [row(100, 1), row(200, 100)];
    const probe = scriptedProbe([
      table([row(100, 1), row(200, 100)]),
      table([row(200, 100)]),
      table([]),
    ]);

    await expect(waitForSnapshotExit({ processes, probe, budgetMs: 5_000, pollIntervalMs: 10, ...fastClock() }))
      .resolves.toEqual({ status: 'exited', scope: SCOPE, observedProcessCount: 2 });
  });

  it('treats a recycled pid as an exit of the captured process', async () => {
    await expect(waitForSnapshotExit({
      processes: [row(100, 1, 'start-a')],
      probe: scriptedProbe([table([row(100, 1, 'start-b')])]),
      budgetMs: 5_000,
      pollIntervalMs: 10,
      ...fastClock(),
    })).resolves.toEqual({ status: 'exited', scope: SCOPE, observedProcessCount: 1 });
  });

  it('treats an unreaped zombie as an exit', async () => {
    await expect(waitForSnapshotExit({
      processes: [row(100, 1)],
      probe: scriptedProbe([table([row(100, 1, '10000', true)])]),
      budgetMs: 5_000,
      pollIntervalMs: 10,
      ...fastClock(),
    })).resolves.toEqual({ status: 'exited', scope: SCOPE, observedProcessCount: 1 });
  });

  it('reports timeout with the survivor count when a captured process outlives the budget', async () => {
    await expect(waitForSnapshotExit({
      processes: [row(100, 1), row(200, 100)],
      probe: scriptedProbe([table([row(200, 100)])]),
      budgetMs: 50,
      pollIntervalMs: 10,
      ...fastClock(),
    })).resolves.toEqual({
      status: 'timeout',
      scope: SCOPE,
      observedProcessCount: 2,
      remainingProcessCount: 1,
    });
  });

  it('reports unavailable when a captured pid becomes unreadable mid-wait', async () => {
    await expect(waitForSnapshotExit({
      processes: [row(100, 1)],
      probe: scriptedProbe([table([row(100, 1)]), { status: 'unreadable' }]),
      budgetMs: 5_000,
      pollIntervalMs: 10,
      ...fastClock(),
    })).resolves.toEqual({
      status: 'unavailable',
      scope: SCOPE,
      detail: 'process-table-unreadable',
      observedProcessCount: 1,
    });
  });

  it('never rescans the whole table while observing', async () => {
    let scans = 0;
    const probe: ProcessProbe = {
      scan: async () => { scans++; return table([]); },
      probe: async () => ({ status: 'absent' }),
    };
    await waitForSnapshotExit({ processes: [row(100, 1)], probe, ...fastClock() });
    expect(scans).toBe(0);
  });

  it('stops issuing reads once the budget is spent, mid-pass', async () => {
    // 400 live processes, each read slow but successful. Without a deadline
    // inside the pass this would run 400 * 200 ms before ever checking.
    let clock = 0;
    let reads = 0;
    const processes = Array.from({ length: 400 }, (_, i) => row(1_000 + i, 100));
    const probe = createProcProcessProbe({
      platform: 'linux',
      listProc: async () => ({ status: 'unreadable' }),
      readProcStat: async (pid) => {
        reads++;
        clock += 200;
        return { status: 'ok', content: statLine({ pid, ppid: 100, startToken: `${pid}00` }) };
      },
    });

    const verification = await waitForSnapshotExit({
      processes,
      probe,
      budgetMs: 1_000,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    expect(verification.status).toBe('timeout');
    expect(verification.remainingProcessCount).toBe(400);
    expect(reads).toBeLessThanOrEqual(6);
  });
});

/**
 * Real processes, real exits.
 *
 * On Linux this runs the shipping `/proc` probe. Elsewhere `/proc` does not
 * exist, so the probe is a `ps`-backed stand-in built here: pids, parent links
 * and liveness are real, only the table's source differs. What that leaves
 * unproven off Linux is the `/proc` reader itself, which the fixture and
 * Linux-gated tests above cover.
 */
function realProcessProbe(): ProcessProbe {
  if (process.platform === 'linux') return createProcProcessProbe(createProcFs());

  const ps = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile('ps', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  const parse = (stdout: string): ProcessRow[] => {
    const rows: ProcessRow[] = [];
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const [pid, ppid, stat, ...started] = parts;
      rows.push({
        pid: Number(pid),
        ppid: Number(ppid),
        startToken: started.join(' '),
        zombie: (stat ?? '').startsWith('Z'),
      });
    }
    return rows;
  };

  return {
    scan: async (deadline) => {
      if (deadline.expired()) return { status: 'expired' };
      const stdout = await ps(['-Ao', 'pid=,ppid=,stat=,lstart=']);
      return stdout === null ? { status: 'unreadable' } : { status: 'ok', rows: parse(stdout) };
    },
    probe: async (pid, deadline) => {
      if (deadline.expired()) return { status: 'expired' };
      const stdout = await ps(['-o', 'pid=,ppid=,stat=,lstart=', '-p', String(pid)]);
      // `ps -p` exits non-zero for a pid that does not exist — absence, not a
      // read failure. The `/proc` probe answers the same way via ENOENT.
      if (stdout === null) return { status: 'absent' };
      const found = parse(stdout).find((r) => r.pid === pid);
      return found ? { status: 'alive', row: found } : { status: 'absent' };
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('verified stop against real processes', () => {
  it('reports exited after the captured shell and its child are terminated', async () => {
    const probe = realProcessProbe();
    // A shell with one child; `wait` keeps the shell alive while the child runs.
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    const rootPid = child.pid!;
    try {
      expect(await waitFor(async () => {
        const snapshot = await captureSessionProcessTree({ rootPid, probe });
        return snapshot.kind === 'captured' && snapshot.processes.length >= 2;
      })).toBe(true);

      const snapshot = await captureSessionProcessTree({ rootPid, probe });
      if (snapshot.kind !== 'captured') throw new Error(`snapshot not captured: ${snapshot.detail}`);
      expect(snapshot.processes.length).toBeGreaterThanOrEqual(2);

      for (const captured of snapshot.processes) {
        try { process.kill(captured.pid, 'SIGKILL'); } catch { /* already gone */ }
      }

      await expect(waitForSnapshotExit({
        processes: snapshot.processes,
        probe,
        budgetMs: 5_000,
        pollIntervalMs: 50,
      })).resolves.toEqual({
        status: 'exited',
        scope: SCOPE,
        observedProcessCount: snapshot.processes.length,
      });
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 20_000);

  it('reports timeout when a captured descendant survives the stop of its parent', async () => {
    const probe = realProcessProbe();
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    const rootPid = child.pid!;
    let survivors: ProcessRow[] = [];
    try {
      expect(await waitFor(async () => {
        const snapshot = await captureSessionProcessTree({ rootPid, probe });
        return snapshot.kind === 'captured' && snapshot.processes.length >= 2;
      })).toBe(true);

      const snapshot = await captureSessionProcessTree({ rootPid, probe });
      if (snapshot.kind !== 'captured') throw new Error(`snapshot not captured: ${snapshot.detail}`);
      survivors = snapshot.processes.filter((p) => p.pid !== rootPid);

      // Exactly what `stopSession` does: signal the root only. The `sleep` is
      // reparented and keeps running — the case this feature exists for.
      process.kill(rootPid, 'SIGKILL');

      const verification = await waitForSnapshotExit({
        processes: snapshot.processes,
        probe,
        budgetMs: 600,
        pollIntervalMs: 50,
      });
      expect(verification.status).toBe('timeout');
      expect(verification.scope).toBe(SCOPE);
      expect(verification.remainingProcessCount).toBeGreaterThanOrEqual(1);
    } finally {
      for (const survivor of survivors) {
        try { process.kill(survivor.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 20_000);
});

describe('stopSessionWithVerifiedExit', () => {
  // One stable object per session: the orchestrator compares it by reference
  // to notice that tracking was replaced.
  const tracked = (pid: number) => {
    const target = { pid, token: { id: `session-${pid}` } };
    return () => target;
  };
  const stopped = { stopped: true } as const;

  it('verifies the captured tree and reports exited', async () => {
    const stop = vi.fn(() => stopped);
    const findTarget = tracked(100);
    const probe = scriptedProbe([
      table([row(100, 1), row(200, 100)]),
      table([row(100, 1), row(200, 100)]),
      table([]),
    ]);

    await expect(stopSessionWithVerifiedExit({
      findTarget,
      stop,
      probe,
      ...fastClock(),
    })).resolves.toEqual({
      result: stopped,
      exitVerification: { status: 'exited', scope: SCOPE, observedProcessCount: 2 },
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not signal when the session stopped being tracked during the capture', async () => {
    const stop = vi.fn(() => stopped);
    let target: { pid: number; token: unknown } | undefined = { pid: 100, token: {} };
    const probe = scriptedProbe([table([row(100, 1), row(200, 100)])]);

    await expect(stopSessionWithVerifiedExit({
      findTarget: () => {
        const current = target;
        target = undefined; // gone by the time the stop would be issued
        return current;
      },
      stop,
      probe,
      ...fastClock(),
    })).resolves.toEqual({
      result: { stopped: false, reason: 'not-found' },
      exitVerification: { status: 'not-tracked', scope: SCOPE, detail: 'session-not-tracked' },
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not signal when the tracking entry was replaced during the capture', async () => {
    const stop = vi.fn(() => stopped);
    const targets = [
      { pid: 100, token: { id: 'session-100' } },
      { pid: 100, token: { id: 'a different session on the same pid' } },
    ];
    const probe = scriptedProbe([table([row(100, 1)])]);

    await expect(stopSessionWithVerifiedExit({
      findTarget: () => targets.shift() ?? undefined,
      stop,
      probe,
      ...fastClock(),
    })).resolves.toEqual({
      result: { stopped: false, reason: 'not-found' },
      exitVerification: { status: 'not-tracked', scope: SCOPE, detail: 'session-not-tracked' },
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not signal a pid the capture found absent or recycled', async () => {
    for (const [scan, detail] of [
      [table([row(1, 0)]), 'root-process-absent'],
      // scan sees the root, the recheck finds another process on its pid
      [table([row(100, 1, 'start-a')]), 'root-identity-changed'],
    ] as const) {
      const stop = vi.fn(() => stopped);
      const probe = detail === 'root-process-absent'
        ? scriptedProbe([scan])
        : scriptedProbe([scan, table([row(100, 1, 'start-b')])]);

      await expect(stopSessionWithVerifiedExit({
        findTarget: tracked(100),
        stop,
        probe,
        ...fastClock(),
      })).resolves.toEqual({
        result: { stopped: false, reason: 'not-found' },
        exitVerification: { status: 'unavailable', scope: SCOPE, detail },
      });
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it('keeps the legacy stop when the platform carries no evidence, and marks it unavailable', async () => {
    const stop = vi.fn(() => stopped);
    await expect(stopSessionWithVerifiedExit({
      findTarget: tracked(100),
      stop,
      probe: scriptedProbe([{ status: 'unsupported' }]),
      ...fastClock(),
    })).resolves.toEqual({
      result: stopped,
      exitVerification: { status: 'unavailable', scope: SCOPE, detail: 'platform-unsupported' },
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports not-tracked, never exited, for a session the daemon does not track', async () => {
    const stop = vi.fn(() => ({ stopped: false, reason: 'not-found' }) as const);
    await expect(stopSessionWithVerifiedExit({
      findTarget: () => undefined,
      stop,
      probe: scriptedProbe([table([])]),
      ...fastClock(),
    })).resolves.toEqual({
      result: { stopped: false, reason: 'not-found' },
      exitVerification: { status: 'not-tracked', scope: SCOPE, detail: 'session-not-tracked' },
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports a refused stop as unverified rather than as an exit', async () => {
    const refusal = { stopped: false, reason: 'active', guard: 'thinking',
      activity: { thinking: true, hasOpenToolCall: false, pendingUserInput: false } } as const;
    await expect(stopSessionWithVerifiedExit({
      findTarget: tracked(100),
      stop: () => refusal,
      probe: scriptedProbe([table([row(100, 1)])]),
      ...fastClock(),
    })).resolves.toEqual({
      result: refusal,
      exitVerification: { status: 'unavailable', scope: SCOPE, detail: 'stop-refused' },
    });
  });

  it('reports timeout when a captured process outlives the stop', async () => {
    const probe = scriptedProbe([
      table([row(100, 1), row(200, 100)]),
      table([row(100, 1), row(200, 100)]),
    ]);
    const verified = await stopSessionWithVerifiedExit({
      findTarget: tracked(100),
      stop: () => stopped,
      probe,
      waitBudgetMs: 100,
      pollIntervalMs: 10,
      ...fastClock(),
    });
    expect(verified.exitVerification.status).toBe('timeout');
    expect(verified.exitVerification.remainingProcessCount).toBe(2);
  });
});
