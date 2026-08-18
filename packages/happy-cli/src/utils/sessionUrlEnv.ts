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
 * inherited parent APLUS_SESSION_* before spawn. A nested happy run that does
 * NOT go through the daemon (agent shell exec'ing happy directly) can still
 * keep the parent's value due to first-set-wins — not a secret, worst case an
 * inaccurate link.
 */

/** Builds the web URL for a session, e.g. https://saycode.ai/session/<id>. */
export function buildSessionWebUrl(sessionId: string, webappUrl: string): string {
    return new URL(`/session/${sessionId}`, webappUrl).toString();
}

/**
 * Sets APLUS_SESSION_URL / APLUS_SESSION_ID on the given env unless already
 * present. First-set wins: an explicitly injected value (e.g. by a spawner)
 * must not be overwritten, and each key is preserved independently.
 */
export function applySessionUrlEnv(
    env: NodeJS.ProcessEnv,
    sessionId: string,
    webappUrl: string,
): void {
    if (!env.APLUS_SESSION_URL) {
        env.APLUS_SESSION_URL = buildSessionWebUrl(sessionId, webappUrl);
    }
    if (!env.APLUS_SESSION_ID) {
        env.APLUS_SESSION_ID = sessionId;
    }
}
