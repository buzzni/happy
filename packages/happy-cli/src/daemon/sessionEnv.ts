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
 *
 * APLUS_SESSION_* is the session's own web URL/id exported for agent shell
 * subprocesses (sessionUrlEnv.ts). Scrub it here so a daemon-spawned session
 * starts without stale identity; the child session factory then writes its
 * confirmed current id.
 *
 * SAYCODE_AGENT_* grants per-session orchestration scope. A daemon restarted
 * by one agent must not leak that agent's root/depth/id into unrelated spawns;
 * tracked sessions re-add their captured capability explicitly on resume.
 */
// 'HAPPY_INITIAL_' covers HAPPY_INITIAL_PROMPT(_LOCAL_ID) and the
// HAPPY_INITIAL_MODEL / HAPPY_INITIAL_EFFORT spawn seeds.
export const SESSION_LINEAGE_ENV_PREFIXES = ['HAPPY_RECONNECT_', 'HAPPY_FORK', 'HAPPY_CREATED_BY', 'HAPPY_INITIAL_', 'HAPPY_AUTOMATION_', 'APLUS_SESSION_', 'SAYCODE_AGENT_'] as const

const SAYCODE_AGENT_ENV_KEYS = [
    'SAYCODE_AGENT_ENV',
    'SAYCODE_AGENT_ROOT',
    'SAYCODE_AGENT_DEPTH',
    'SAYCODE_AGENT_MAX_SPAWN',
    'SAYCODE_AGENT_ID',
] as const

type SaycodeAgentEnvironmentKey = typeof SAYCODE_AGENT_ENV_KEYS[number]

export type SaycodeAgentEnvironment = Partial<Record<SaycodeAgentEnvironmentKey, string>> & {
    SAYCODE_AGENT_ENV: '1'
    SAYCODE_AGENT_ROOT: string
}

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

/** Builds one child environment after removing stale inherited lineage. */
export function buildSessionSpawnEnvironment(
    inherited: NodeJS.ProcessEnv,
    explicit: Record<string, string>,
): Record<string, string> {
    return {
        ...scrubSessionLineageEnv(inherited),
        ...explicit,
    }
}

/** Retains only the per-session Saycode capability needed by a later resume. */
export function captureSaycodeAgentEnvironment(
    env: NodeJS.ProcessEnv,
): SaycodeAgentEnvironment | undefined {
    if (env.SAYCODE_AGENT_ENV !== '1' || !env.SAYCODE_AGENT_ROOT?.trim()) {
        return undefined
    }
    return Object.fromEntries(
        SAYCODE_AGENT_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
    ) as SaycodeAgentEnvironment
}

/** Restores one tracked session's capability without inheriting the caller's. */
export function buildResumedSessionSpawnEnvironment(input: {
    inherited: NodeJS.ProcessEnv
    explicit: Record<string, string>
    agentEnvironment?: SaycodeAgentEnvironment
    sessionId: string
}): Record<string, string> {
    return buildSessionSpawnEnvironment(input.inherited, {
        ...input.explicit,
        ...(input.agentEnvironment ?? {}),
        APLUS_SESSION_ID: input.sessionId,
    })
}
