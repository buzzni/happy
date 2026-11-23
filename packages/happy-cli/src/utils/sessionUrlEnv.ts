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
 * NON_INHERITABLE_ENV scrub in utils/childEnv.ts, which strips an
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

export type SessionLinks = { APLUS_SESSION_ID: string; APLUS_SESSION_URL: string };

/** Validate the public links before forwarding them through a provider's late settings. */
export function readSessionLinks(env: NodeJS.ProcessEnv): SessionLinks | undefined {
    const id = env.APLUS_SESSION_ID, link = env.APLUS_SESSION_URL;
    if (!id || !/^[\w-]{1,160}$/.test(id) || !link) return;
    try {
        const url = new URL(link);
        if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== `/session/${id}`
            || url.username || url.password || url.search || url.hash) return;
        return { APLUS_SESSION_ID: id, APLUS_SESSION_URL: link };
    } catch { return undefined; }
}

export function withoutSessionLinks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const { APLUS_SESSION_ID: _id, APLUS_SESSION_URL: _url, ...remaining } = env;
    return remaining;
}
