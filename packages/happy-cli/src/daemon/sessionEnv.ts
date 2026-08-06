/**
 * Session lineage environment variables must never be inherited implicitly.
 *
 * HAPPY_RECONNECT_* attaches a child to an EXISTING happy session and
 * HAPPY_FORK* attaches provider-conversation lineage. They are only valid
 * when the daemon sets them explicitly for one specific spawn (resumeSession
 * / fork RPC). If they leak through `...process.env` — e.g. a resumed child
 * auto-restarts the daemon on version mismatch, and the daemon inherits the
 * child's env — every session the daemon spawns afterwards reconnects to the
 * same happy session. That is the 2026-07-19 incident: chats from every
 * project queued into one session and replayed each other's prompts.
 */
export const SESSION_LINEAGE_ENV_PREFIXES = ['HAPPY_RECONNECT_', 'HAPPY_FORK', 'HAPPY_CREATED_BY', 'HAPPY_INITIAL_PROMPT'] as const

function isLineageKey(key: string): boolean {
    return SESSION_LINEAGE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** Returns a copy of `env` without lineage variables (and without undefined values). */
export function scrubSessionLineageEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const scrubbed: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || isLineageKey(key)) continue
        scrubbed[key] = value
    }
    return scrubbed
}
