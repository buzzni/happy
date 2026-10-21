/**
 * Who started a session — written once into session metadata as `source` so every
 * client can tell automation-run conversations apart without device-local guesses
 * (aplus-dev-studio specs/session-source-metadata).
 *
 * An open string enum: a newer client may send a value this build does not list,
 * and it is still recorded. Readers treat an unknown value as "not known", never
 * as `user`.
 */
export type SessionSource =
    | 'user'
    | 'schedule'
    | 'autopilot'
    | 'github-trigger'
    | 'review'
    | 'channel'
    | 'fanout'
    | (string & {});

/**
 * Per-spawn env carrying the source into the runner. Under the `HAPPY_CREATED_BY`
 * prefix on purpose: that prefix is already scrubbed as lineage
 * (SESSION_LINEAGE_ENV_PREFIXES, managed runtime reuse), so a child the session
 * spawns never inherits its parent's source.
 */
export const SESSION_SOURCE_ENV = 'HAPPY_CREATED_BY_SOURCE';

const SESSION_SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The value when it is a well-formed tag, else undefined — never a guess. */
export function normalizeSessionSource(value: unknown): SessionSource | undefined {
    return typeof value === 'string' && SESSION_SOURCE_PATTERN.test(value) ? value : undefined;
}

/**
 * Read once by the runner and removed, like the HAPPY_INITIAL_* seeds: anything the session
 * later starts from its own shell (a `happy` run, a resume child) must not record this source.
 */
export function takeSessionSourceFromEnv(env: NodeJS.ProcessEnv = process.env): SessionSource | undefined {
    const source = normalizeSessionSource(env[SESSION_SOURCE_ENV]);
    delete env[SESSION_SOURCE_ENV];
    return source;
}
