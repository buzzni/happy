/**
 * Session URL environment export (specs/desktop-issue-pr-session-link R2, desktop repo)
 *
 * Once a child runtime knows its own session id, it exports APLUS_SESSION_URL /
 * APLUS_SESSION_ID so agent shell subprocesses inherit them. Automation preset
 * prompts (e.g. GitHub-triggered PR creation) read APLUS_SESSION_URL to embed a
 * "continue this session" web link in PR bodies.
 *
 * Not a secret: the value is just the public webapp origin plus the session id.
 * Access to the session itself is still gated by the webapp's own auth.
 *
 * Lineage inheritance: daemon-spawned children are protected by the
 * SESSION_LINEAGE_ENV_PREFIXES scrub in daemon/sessionEnv.ts, which strips an
 * inherited parent APLUS_SESSION_* before spawn. The session factory also
 * replaces any stale inherited value once it knows the current Happy session
 * id, covering nested runs that do not pass through the daemon scrub.
 */

/** Builds the web URL for a session, e.g. https://saycode.ai/session/<id>. */
export function buildSessionWebUrl(sessionId: string, webappUrl: string): string {
    return new URL(`/session/${sessionId}`, webappUrl).toString();
}

/**
 * Sets APLUS_SESSION_URL / APLUS_SESSION_ID to the session this process is
 * currently syncing. The confirmed session id wins over inherited process
 * state; otherwise a nested or resumed process can identify its parent as self.
 */
export function applySessionUrlEnv(
    env: NodeJS.ProcessEnv,
    sessionId: string,
    webappUrl: string,
): void {
    env.APLUS_SESSION_URL = buildSessionWebUrl(sessionId, webappUrl);
    env.APLUS_SESSION_ID = sessionId;
}
