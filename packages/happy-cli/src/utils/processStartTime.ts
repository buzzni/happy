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
 * It is also a blocking subprocess, so callers should filter to PIDs worth
 * asking about (e.g. live ones) before calling it in a loop.
 */
export function getProcessStartedAt(pid: number): number | undefined {
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // `lstart` prints month/day names, and Date.parse only understands the C
      // locale's. Without this a non-English LC_TIME yields NaN, which we would
      // read as "cannot verify" and silently stop adopting anything.
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    if (!output) return undefined;

    const parsed = Date.parse(output);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Windows counterpart of {@link getProcessStartedAt}: `ps` does not exist there.
 * CIM reports the creation time of any process, including ones the caller may
 * not open. It costs a PowerShell start, so call it only for a live pid that
 * actually needs checking. Undefined means "cannot verify", as above.
 */
export function getWindowsProcessStartedAt(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
    ], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (!output) return undefined;
    const parsed = Date.parse(output);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
