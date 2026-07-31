import { execFileSync } from 'node:child_process';

/**
 * Wall-clock time a process started, in epoch milliseconds.
 *
 * Used to tell a session's original process apart from an unrelated one that
 * inherited its PID. Returns undefined when the process is gone or the platform
 * doesn't answer — callers must treat that as "cannot verify" and act
 * conservatively, never as "verified".
 *
 * `ps -o lstart=` is available on macOS and Linux and reports whole seconds,
 * which is fine here: the comparison it feeds has seconds of slack by design.
 */
export function getProcessStartedAt(pid: number): number | undefined {
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) return undefined;

    const parsed = Date.parse(output);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
