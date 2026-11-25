/**
 * Ordering of Happy CLI version strings (`1.1.10-aplus.394`), shared by the daemon's stale-session
 * sweep and the daemon replacement decision. Kept free of daemon imports so the CLI startup path
 * can read it without loading the session machinery.
 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-aplus\.(\d+))?$/;

/** True only when both versions parse and `session` sorts strictly before `daemon` (semver: a
 *  prerelease sorts before its release). A newer child — spawned from a bundle replaced on disk
 *  under a daemon that has not restarted yet — is never treated as stale. */
export function isOlderRuntimeVersion(session: string | undefined, daemon: string): boolean {
  const a = session ? VERSION.exec(session) : null;
  const b = VERSION.exec(daemon);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  }
  if (a[4] === undefined || b[4] === undefined) return a[4] !== undefined && b[4] === undefined;
  return Number(a[4]) < Number(b[4]);
}
