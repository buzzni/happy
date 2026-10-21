/**
 * The one list of environment variables a child process must never inherit
 * implicitly, and the one helper every child spawn builds its environment with.
 *
 * Each entry is a prefix, compared case-insensitively: environment names are
 * case-insensitive on Windows, so `happy_reconnect_session_id` reaches the
 * same reader there. Explicit values a spawn path writes after sanitizing
 * (resume, fork, the agent grant) are not affected; only inheritance is.
 *
 * Three kinds, by what the value names:
 *
 *  - `session-lineage`: an OTHER session this child would attach to, fork
 *    from or be attributed to. HAPPY_RECONNECT_* attaches a child to an
 *    EXISTING happy session and HAPPY_FORK* attaches provider-conversation
 *    lineage. They are only valid when the daemon sets them explicitly for one
 *    specific spawn (resumeSession / fork RPC). If they leak through
 *    `...process.env` — e.g. a resumed child auto-restarts the daemon on
 *    version mismatch, and the daemon inherits the child's env — every session
 *    the daemon spawns afterwards reconnects to the same happy session. That is
 *    the 2026-07-19 incident: chats from every project queued into one session
 *    and replayed each other's prompts.
 *  - `spawn-seed`: one-shot input to the runner of this spawn. 'HAPPY_INITIAL_'
 *    covers HAPPY_INITIAL_PROMPT(_LOCAL_ID) and the HAPPY_INITIAL_MODEL /
 *    HAPPY_INITIAL_EFFORT spawn seeds; the browser task session secret is read
 *    once by the runner's MCP server.
 *  - `session-scope`: the current session's own identity, grants and policy.
 *    Its own children (the agent CLI, its tool shells, `happy agent`) need
 *    them; a process that starts or hosts another session must not carry them.
 *    APLUS_SESSION_* is the session's web URL/id for agent shell subprocesses
 *    (sessionUrlEnv.ts). SAYCODE_AGENT_* grants per-session orchestration
 *    scope; tracked sessions re-add their captured capability explicitly on
 *    resume. HAPPY_CHECKPOINT_* binds protected checkpoint state to one
 *    daemon-verified project/worktree. 'HAPPY_AI_AUTH_' covers
 *    HAPPY_AI_AUTH_SOURCE and HAPPY_AI_AUTH_CONNECTION_VERSION: which
 *    credential a session is actually spending is decided per spawn, never
 *    inherited — an un-scrubbed value would make every later session on the
 *    machine meter its tokens against somebody else's credential.
 */
export type NonInheritableEnvKind = 'session-lineage' | 'spawn-seed' | 'session-scope'

export type NonInheritableEnvEntry = { readonly prefix: string; readonly kind: NonInheritableEnvKind }

export const NON_INHERITABLE_ENV: readonly NonInheritableEnvEntry[] = [
    { prefix: 'HAPPY_RECONNECT_', kind: 'session-lineage' },
    // Covers both `HAPPY_FORK_*` (the native session or thread to resume and
    // backfill from) and `HAPPY_FORKED_FROM_*` (the lineage recorded in metadata).
    { prefix: 'HAPPY_FORK', kind: 'session-lineage' },
    { prefix: 'HAPPY_CREATED_BY', kind: 'session-lineage' },
    { prefix: 'HAPPY_DEFERRED_CONTINUATION_', kind: 'session-lineage' },
    { prefix: 'HAPPY_INITIAL_', kind: 'spawn-seed' },
    { prefix: 'HAPPY_BROWSER_TASK_SESSION_SECRET', kind: 'spawn-seed' },
    { prefix: 'HAPPY_SCOPE_REPORT_', kind: 'session-scope' },
    { prefix: 'HAPPY_WRITE_SCOPE_', kind: 'session-scope' },
    { prefix: 'HAPPY_AUTOMATION_', kind: 'session-scope' },
    { prefix: 'HAPPY_ADDITIONAL_DIRECTORIES', kind: 'session-scope' },
    { prefix: 'HAPPY_CHECKPOINT_', kind: 'session-scope' },
    { prefix: 'HAPPY_AI_AUTH_', kind: 'session-scope' },
    { prefix: 'APLUS_SESSION_', kind: 'session-scope' },
    { prefix: 'SAYCODE_AGENT_', kind: 'session-scope' },
]

/**
 * Where the child sits relative to the caller's session.
 *
 *  - `session` (default): the child starts or hosts sessions of its own, or
 *    belongs to none — the daemon and what it spawns, the channel host, a
 *    detached `happy` command, a terminal, a script. Every entry is dropped.
 *  - `in-session`: the child works inside the caller's session — the agent CLI
 *    a runner launches and the shells it runs. Only lineage and spawn seeds
 *    are dropped; the session's own scope stays.
 */
export type ChildEnvBoundary = 'session' | 'in-session'

/**
 * Secret-free record of which managed setup-token generation a session was started on.
 * Daemon-written only: the HAPPY_AI_AUTH_ prefix is scrubbed from inherited and
 * requested environments, so neither can forge or carry it to another session.
 */
export const SETUP_TOKEN_BINDING_ENV = 'HAPPY_AI_AUTH_SETUP_TOKEN_BINDING'

export function nonInheritableEnvEntry(key: string): NonInheritableEnvEntry | undefined {
    const name = key.toUpperCase()
    return NON_INHERITABLE_ENV.find((entry) => name.startsWith(entry.prefix))
}

function isDropped(key: string, boundary: ChildEnvBoundary): boolean {
    const entry = nonInheritableEnvEntry(key)
    return entry !== undefined && (boundary === 'session' || entry.kind !== 'session-scope')
}

/** Returns a copy of `env` without non-inheritable variables (and without undefined values). */
export function sanitizeChildEnv(
    env: NodeJS.ProcessEnv,
    options: { boundary?: ChildEnvBoundary } = {},
): Record<string, string> {
    const boundary = options.boundary ?? 'session'
    // A child can restart the daemon. Drop its bound bearer before losing
    // the marker, including malformed markers; unbound personal auth stays.
    // Inside the session the bound token is the one the agent must spend.
    const dropBoundBearer = boundary === 'session'
        && Object.keys(env).some((key) => key.toUpperCase() === SETUP_TOKEN_BINDING_ENV && env[key] !== undefined)
    const sanitized: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || isDropped(key, boundary)) continue
        if (dropBoundBearer && key.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN') continue
        sanitized[key] = value
    }
    return sanitized
}

/**
 * Deletes, in place, every inherited variable naming another session.
 *
 * For a runner whose own environment is not one the daemon just built (a
 * reused managed runtime): it forgets the earlier launch's lineage before
 * reading its own. Spawn seeds stay — they are this run's own input.
 */
export function clearInheritedSessionLineage(env: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(env)) {
        if (nonInheritableEnvEntry(key)?.kind === 'session-lineage') delete env[key]
    }
}
