/**
 * Which credential a run actually spent, as the usage ledger names it.
 *
 * The ledger (`AiUsageEvent` in aplus-dev-studio) records an auth source beside
 * every token count so a company can tell its own spend from a person's own
 * subscription. The CLI is the only place that knows what the agent was
 * *actually* launched with, so the value has to be decided here; without it
 * every event lands in the `unknown` bucket.
 *
 * The token set is a **copy** of `packages/web-ui/server/aiAuthSource.ts` on
 * the Studio side — there is no shared package across that boundary. A token
 * that drifts is not a type error anywhere: it is silently downgraded to
 * `unknown` by the receiving ledger, which is the same as not reporting at all.
 *
 * Pure on purpose: no filesystem, no `process.env`, nothing to inject. It
 * reads an environment it is handed and, for a managed run, the kind the
 * parent already decided.
 *
 * ## Not guessing is the point
 *
 * An unverified source is `unknown`, never a default. Writing `unknown` down
 * as `personal-subscription` meters the run against somebody's own Claude
 * subscription — this is a security property of the attribution, not a
 * presentation nicety.
 *
 * ## Requirement for the daemon track (not implemented here)
 *
 * `HAPPY_AI_AUTH_SOURCE` (and `HAPPY_AI_AUTH_CONNECTION_VERSION`) **must** be
 * added to `SESSION_LINEAGE_ENV_PREFIXES` in `src/daemon/sessionEnv.ts` — a
 * `HAPPY_AI_AUTH_` prefix covers both. The daemon can be restarted by a child
 * and then inherits that child's whole environment; an un-scrubbed value means
 * every later session on that machine reports somebody else's credential as
 * its own. This is the same shape as the 2026-07-19 session cross-over the
 * header of `sessionEnv.ts` describes.
 */
import { MANAGED_AI_AUTH_GLM_BASE_URL, type ManagedAiAuthKind } from '@/managed/managedAiAuth'

/** The closed set the ledger understands. Anything else is `unknown`. */
export const AI_AUTH_SOURCES = [
    /** The running machine's own CLI login. */
    'personal-subscription',
    /** The running machine's own key file or environment variable. */
    'personal-api-key',
    /** A bundle the organisation deployed (cswap / codex-multi-auth). */
    'org-bundle',
    /** A Z.AI key the platform leased. */
    'platform-glm',
    /** A Cloud gateway capability. */
    'platform-gateway',
    /** Not established. Never inferred. */
    'unknown',
] as const

export type AiAuthSource = (typeof AI_AUTH_SOURCES)[number]

/**
 * How the daemon tells a child which credential it launched it with.
 *
 * The daemon is the only layer that can separate an organisation bundle from a
 * person's own key — both end up as `ANTHROPIC_API_KEY` in the child — so the
 * decision travels as a value rather than being re-derived downstream.
 *
 * Must be scrubbed as session lineage; see the module header.
 */
export const HAPPY_AI_AUTH_SOURCE_ENV = 'HAPPY_AI_AUTH_SOURCE'

/** The connection version the source was resolved from, when there is one. */
export const HAPPY_AI_AUTH_CONNECTION_VERSION_ENV = 'HAPPY_AI_AUTH_CONNECTION_VERSION'

/** Exact tokens only — a cased variant is a token this build does not know. */
export function normalizeAiAuthSource(value: unknown): AiAuthSource {
    if (typeof value !== 'string') return 'unknown'
    const trimmed = value.trim()
    return (AI_AUTH_SOURCES as readonly string[]).includes(trimmed)
        ? (trimmed as AiAuthSource)
        : 'unknown'
}

/**
 * `ManagedAiAuthKind` → ledger source.
 *
 * One-to-one for the four kinds a managed envelope can carry. A personal GLM
 * key stays `personal-api-key`: it is the requester's own key, a different
 * axis from the platform's leased `platform-glm` route.
 */
const SOURCE_BY_MANAGED_KIND: Readonly<Record<ManagedAiAuthKind, AiAuthSource>> = Object.freeze({
    'platform-gateway': 'platform-gateway',
    'platform-glm': 'platform-glm',
    'personal-subscription': 'personal-subscription',
    'personal-api-key': 'personal-api-key',
})

export function aiAuthSourceForManagedKind(kind: unknown): AiAuthSource {
    if (typeof kind !== 'string') return 'unknown'
    return SOURCE_BY_MANAGED_KIND[kind as ManagedAiAuthKind] ?? 'unknown'
}

function isGlmBaseUrl(value: string | undefined): boolean {
    if (typeof value !== 'string') return false
    return value.trim().replace(/\/+$/, '') === MANAGED_AI_AUTH_GLM_BASE_URL
}

/**
 * The source this run is actually spending, in order of authority:
 *
 *  1. the managed envelope's `aiAuth.kind` — the parent already decided it and
 *     built the environment from it, so no fingerprint may overturn it;
 *  2. `HAPPY_AI_AUTH_SOURCE`, what the daemon knows and the child cannot see;
 *  3. an environment fingerprint, for what is unambiguous on its own.
 *
 * Only one fingerprint qualifies: Z.AI's Anthropic-compatible base URL, which
 * only the leased GLM route points at. `ANTHROPIC_API_KEY` deliberately does
 * **not** qualify — an organisation bundle and a person's own key are the same
 * variable, and telling them apart is exactly what layer 2 is for. Guessing
 * either one bills the wrong party.
 */
export function resolveAppliedAiAuthSource(input: {
    env: Record<string, string | undefined>
    /** `envelope.aiAuth.kind`, for a managed Cloud run. */
    managedAiAuthKind?: string | null
}): AiAuthSource {
    if (input.managedAiAuthKind !== undefined && input.managedAiAuthKind !== null) {
        return aiAuthSourceForManagedKind(input.managedAiAuthKind)
    }
    const injected = normalizeAiAuthSource(input.env[HAPPY_AI_AUTH_SOURCE_ENV])
    if (injected !== 'unknown') return injected
    if (isGlmBaseUrl(input.env.ANTHROPIC_BASE_URL)) return 'platform-glm'
    return 'unknown'
}

/** The injected connection version, or `null` when there is no usable one. */
export function readAiAuthConnectionVersion(env: Record<string, string | undefined>): number | null {
    const raw = env[HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
    const version = Number(raw.trim())
    return Number.isSafeInteger(version) ? version : null
}
