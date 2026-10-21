/**
 * The one list of environment variables a child process must never inherit
 * implicitly, and the one helper every child spawn builds its environment with.
 *
 * HAPPY_RECONNECT_* attaches a child to an EXISTING happy session and
 * HAPPY_FORK* attaches provider-conversation lineage. They are only valid
 * when the daemon sets them explicitly for one specific spawn (resumeSession
 * / fork RPC). If they leak through `...process.env` — e.g. a resumed child
 * auto-restarts the daemon on version mismatch, and the daemon inherits the
 * child's env — every session the daemon spawns afterwards reconnects to the
 * same happy session. That is the 2026-07-19 incident: chats from every
 * project queued into one session and replayed each other's prompts.
 *
 * APLUS_SESSION_* is the session's own web URL/id exported for agent shell
 * subprocesses (sessionUrlEnv.ts). Scrub it here so a daemon-spawned session
 * starts without stale identity; the child session factory then writes its
 * confirmed current id.
 *
 * SAYCODE_AGENT_* grants per-session orchestration scope. A daemon restarted
 * by one agent must not leak that agent's root/depth/id into unrelated spawns;
 * tracked sessions re-add their captured capability explicitly on resume.
 *
 * HAPPY_CHECKPOINT_* binds protected checkpoint state to one daemon-verified
 * project/worktree. It follows the same no-implicit-inheritance rule.
 *
 * 'HAPPY_INITIAL_' covers HAPPY_INITIAL_PROMPT(_LOCAL_ID) and the
 * HAPPY_INITIAL_MODEL / HAPPY_INITIAL_EFFORT spawn seeds.
 * 'HAPPY_AI_AUTH_' covers HAPPY_AI_AUTH_SOURCE and
 * HAPPY_AI_AUTH_CONNECTION_VERSION: which credential a session is actually
 * spending is decided per spawn, never inherited. A daemon restarted by a
 * child inherits that child's environment, and an un-scrubbed value would make
 * every later session on the machine meter its tokens against somebody else's
 * credential.
 */
export const NON_INHERITABLE_ENV = ['HAPPY_SCOPE_REPORT_', 'HAPPY_WRITE_SCOPE_', 'HAPPY_RECONNECT_', 'HAPPY_FORK', 'HAPPY_CREATED_BY', 'HAPPY_INITIAL_', 'HAPPY_DEFERRED_CONTINUATION_', 'HAPPY_AUTOMATION_', 'HAPPY_ADDITIONAL_DIRECTORIES', 'HAPPY_CHECKPOINT_', 'HAPPY_AI_AUTH_', 'APLUS_SESSION_', 'SAYCODE_AGENT_'] as const

/**
 * Secret-free record of which managed setup-token generation a session was started on.
 * Daemon-written only: the HAPPY_AI_AUTH_ prefix is scrubbed from inherited and
 * requested environments, so neither can forge or carry it to another session.
 */
export const SETUP_TOKEN_BINDING_ENV = 'HAPPY_AI_AUTH_SETUP_TOKEN_BINDING'

export function isNonInheritableEnvKey(key: string): boolean {
    return NON_INHERITABLE_ENV.some((prefix) => key.startsWith(prefix))
}

/** Returns a copy of `env` without non-inheritable variables (and without undefined values). */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const sanitized: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || isNonInheritableEnvKey(key)) continue
        // A child can restart the daemon. Drop its bound bearer before losing
        // the marker, including malformed markers; unbound personal auth stays.
        if (env[SETUP_TOKEN_BINDING_ENV] !== undefined && key === 'CLAUDE_CODE_OAUTH_TOKEN') continue
        sanitized[key] = value
    }
    return sanitized
}
