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

/** The env a spawn sets so the runner records `source` (empty when nothing well-formed was asked). */
export function sessionSourceSpawnEnv(value: unknown): Record<string, string> {
    const source = normalizeSessionSource(value);
    return source ? { [SESSION_SOURCE_ENV]: source } : {};
}
