import { MachineSetupTokenBindingV2Schema, parseCanonicalOrgSetupTokenJson, type MachineSetupTokenBindingV2 } from '@slopus/happy-wire'
import { z } from 'zod'
/**
 * Session spawn environments: what a daemon-spawned child gets explicitly on
 * top of an inherited environment that `sanitizeChildEnv` (utils/childEnv.ts)
 * has already cleared of other sessions' lineage, identity and credentials.
 */
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import {
    CHECKPOINT_SPAWN_CONTEXT_ENV_KEY,
    readCheckpointSpawnContext,
} from '@/checkpoint/checkpointSpawnContext'
import {
    HAPPY_AI_AUTH_CONNECTION_VERSION_ENV,
    HAPPY_AI_AUTH_SOURCE_ENV,
    normalizeAiAuthSource,
    resolveAppliedAiAuthSource,
    type AiAuthSource,
} from '@/usage/aiAuthSource'
import { ADDITIONAL_DIRECTORIES_ENV, readAdditionalDirectoriesEnvironment } from '@/utils/additionalDirectoriesEnv'
import { expandEnvironmentVariables } from '@/utils/expandEnvVars'
import { normalizeSessionSource, SESSION_SOURCE_ENV } from '@/utils/sessionSource'
import { DELEGATED_ATTENDANCE_ENV, parseDelegatedAttendance } from '@/api/turnAttendance'
import { sanitizeChildEnv, SETUP_TOKEN_BINDING_ENV } from '@/utils/childEnv'
import { OUTPUT_FORMAT_ENV, parseOutputFormat } from '@/claude/structuredOutput'

function isValidOutputFormatSeed(raw: string): boolean {
    try {
        return parseOutputFormat(JSON.parse(raw)) !== undefined
    } catch {
        return false
    }
}

export { SETUP_TOKEN_BINDING_ENV }

const SAYCODE_AGENT_ENV_KEYS = [
    'SAYCODE_AGENT_ENV',
    'SAYCODE_AGENT_ROOT',
    // The tree siblings may live in (saycode-cli 0.4.0, Desktop ADR-061). Without it a
    // resumed hub silently shrinks back to its own worktree.
    'SAYCODE_AGENT_SCOPE',
    'SAYCODE_AGENT_DEPTH',
    'SAYCODE_AGENT_MAX_SPAWN',
    'SAYCODE_AGENT_ID',
] as const

type SaycodeAgentEnvironmentKey = typeof SAYCODE_AGENT_ENV_KEYS[number]
const CHECKPOINT_CONTEXT_KEY = CHECKPOINT_SPAWN_CONTEXT_ENV_KEY
/** Set from the spawn option `browserContinuation` only (request environment cannot carry HAPPY_AUTOMATION_*). */
export const BROWSER_CONTINUATION_ENV = 'HAPPY_AUTOMATION_BROWSER_CONTINUATION'
type SessionScopedEnvironmentKey = SaycodeAgentEnvironmentKey | typeof OUTPUT_FORMAT_ENV | typeof CHECKPOINT_CONTEXT_KEY | typeof SETUP_TOKEN_BINDING_ENV | 'HAPPY_WRITE_SCOPE_SESSION' | 'HAPPY_SANDBOX_POLICY_MODE' | 'HAPPY_PROJECT_SANDBOX_CONFIG' | typeof ADDITIONAL_DIRECTORIES_ENV | typeof BROWSER_CONTINUATION_ENV

export type SaycodeAgentEnvironment = Partial<Record<SessionScopedEnvironmentKey, string>>

/**
 * Who asked for one spawn: requester identity (specs/session-created-by) and source
 * (aplus-dev-studio specs/session-source-metadata). Re-supplied on every spawn, never
 * lineage — all three live under the scrubbed HAPPY_CREATED_BY prefix. A malformed
 * source is dropped, never stored.
 */
export function buildSessionRequesterEnv(options: {
    createdByAccountId?: string
    createdByDisplayName?: string
    sessionSource?: unknown
}): Record<string, string> {
    const env: Record<string, string> = {}
    if (options.createdByAccountId) env.HAPPY_CREATED_BY_ACCOUNT_ID = options.createdByAccountId
    if (options.createdByDisplayName) env.HAPPY_CREATED_BY_DISPLAY_NAME = options.createdByDisplayName
    const source = normalizeSessionSource(options.sessionSource)
    if (source) env[SESSION_SOURCE_ENV] = source
    return env
}

/** Builds one child environment after removing stale inherited lineage. */
export function buildSessionSpawnEnvironment(
    inherited: NodeJS.ProcessEnv,
    explicit: Record<string, string>,
): Record<string, string> {
    return {
        ...sanitizeChildEnv(inherited),
        ...explicit,
    }
}

/**
 * The Saycode agent capability is supplied per spawn, not inherited.
 *
 * A spawn request carries it in two legitimate cases: the client seeds a root
 * (depth 0) session, and `happy agent spawn` seeds a child (depth + 1) through
 * this same daemon RPC. Scrubbing it with the rest of the lineage left every
 * session without the capability while the orchestration prompt still told it
 * to use `happy agent` — 2026-09-13, `not_agent_env` everywhere.
 *
 * Only these keys, with values saycode-cli can actually use, pass through; a
 * grant that fails any check is dropped whole. A partial grant is worse than
 * none: SAYCODE_AGENT_ENV without a usable root fails isAgentEnv anyway, and a
 * rejected scope would silently shrink the tree the session can see.
 */
const DIRECTORY_VALUE = /^(\/|[A-Za-z]:[\\/]|\\\\)/
const COUNT_VALUE = /^\d{1,9}$/
const AGENT_ID_VALUE = /^[A-Za-z0-9_-]{1,64}$/

function readRequestedSaycodeAgentGrant(
    requested: Record<string, string>,
): SaycodeAgentEnvironment | undefined {
    if (requested.SAYCODE_AGENT_ENV !== '1') return undefined
    const isValid = (key: SaycodeAgentEnvironmentKey, pattern: RegExp): boolean => {
        const value = requested[key]
        return value === undefined || pattern.test(value.trim())
    }
    const root = requested.SAYCODE_AGENT_ROOT?.trim()
    if (!root || !DIRECTORY_VALUE.test(root)) return undefined
    if (!isValid('SAYCODE_AGENT_SCOPE', DIRECTORY_VALUE)) return undefined
    if (!isValid('SAYCODE_AGENT_DEPTH', COUNT_VALUE)) return undefined
    if (!isValid('SAYCODE_AGENT_MAX_SPAWN', COUNT_VALUE)) return undefined
    if (!isValid('SAYCODE_AGENT_ID', AGENT_ID_VALUE)) return undefined
    return Object.fromEntries(
        SAYCODE_AGENT_ENV_KEYS.flatMap((key) => requested[key] === undefined ? [] : [[key, requested[key]]]),
    )
}

/**
 * A spawn, resume or automation request supplies environment for the session, but the Happy process
 * itself runs with it first — before the claude UID switch and the sandbox. Variables that make that
 * process (node, the shells and git it runs) load code, change its paths or trust, or steer Happy's own
 * internals would run the requester's code as the daemon user, who holds the daemon token. Any company
 * member can send such a request, so these never come from one; ordinary project variables still do.
 */
const UNSAFE_REQUEST_ENV_KEYS = new Set([
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REPL_EXTERNAL_MODULE',
    'NODE_ICU_DATA', 'NODE_PRESERVE_SYMLINKS', 'NODE_PRESERVE_SYMLINKS_MAIN',
    'PATH', 'HOME', 'SHELL', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'IFS', 'PROMPT_COMMAND', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSH_ASKPASS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    // OpenSSL loads config, providers and engines (code) from these; bash runs startup options and traces.
    'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'SHELLOPTS', 'BASHOPTS', 'PS4',
])
const UNSAFE_REQUEST_ENV_PREFIXES = ['LD_', 'DYLD_', 'GIT_', 'HAPPY_', 'SAYCODE_', 'BASH_FUNC_']
/** Request values under the Happy/Saycode prefixes that are legitimately per-session (validated elsewhere). */
const REQUEST_ENV_ALLOWED_INTERNAL = new Set(['HAPPY_PROJECT_SANDBOX_CONFIG'])

function isUnsafeRequestKey(key: string): boolean {
    // Environment names are case-insensitive on Windows (Path, node_options): compare them upper-cased.
    const name = key.toUpperCase()
    // Commit identity only; every other GIT_* variable can point git at config, hooks or programs.
    if (REQUEST_ENV_ALLOWED_INTERNAL.has(name) || /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(name)) return false
    if (UNSAFE_REQUEST_ENV_KEYS.has(name) || name.endsWith('_PROXY')) return true
    return UNSAFE_REQUEST_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Returns a copy of request-supplied environment without the variables above. */
export function stripUnsafeRequestedEnvironment(requested: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(requested).filter(([key]) => !isUnsafeRequestKey(key)))
}

/**
 * The browser PoC harness points a session at its Runtime and grant file through the request. Only an
 * isolated PoC daemon started with HAPPY_BROWSER_POC_REQUEST_ENV=1 (its own environment, never a request;
 * the installer never sets it) admits these two.
 */
const POC_BROWSER_TASK_REQUEST_KEYS = ['HAPPY_BROWSER_TASK_RUNTIME_URL', 'HAPPY_BROWSER_TASK_GRANT_FILE'] as const

/**
 * The delegating parent's attendance (aplus-dev-studio specs/codexcli-approval-session-binding R12)
 * a `happy agent spawn` request carries for the child's first prompt. Only the two values pass;
 * a forged one can only make the child decline sooner or wait, never approve.
 */
function readRequestedDelegatedAttendance(requested: Record<string, string>): Record<string, string> {
    const value = Object.hasOwn(requested, DELEGATED_ATTENDANCE_ENV) ? parseDelegatedAttendance(requested[DELEGATED_ATTENDANCE_ENV]) : null
    return value ? { [DELEGATED_ATTENDANCE_ENV]: value } : {}
}

/** Keeps request-supplied project env from impersonating daemon-owned session state. */
export function buildSpawnRequestEnvironment(
    auth: Record<string, string>,
    requested: Record<string, string> | undefined,
    options: { allowPocBrowserTaskEnv?: boolean } = {},
): Record<string, string> {
    const poc = options.allowPocBrowserTaskEnv
        ? Object.fromEntries(POC_BROWSER_TASK_REQUEST_KEYS.flatMap((key) => requested?.[key] === undefined ? [] : [[key, requested[key]]]))
        : {}
    return {
        ...sanitizeChildEnv(stripUnsafeRequestedEnvironment(requested ?? {})),
        ...poc,
        // The agent grant is re-admitted only after its own validation (paths and counts).
        ...readRequestedSaycodeAgentGrant(requested ?? {}),
        ...readRequestedDelegatedAttendance(requested ?? {}),
        ...auth,
    }
}

export function overlayManagedCredentialEnvironment(
    requested: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    return { ...stripManagedCredentialConflicts(requested, managed), ...managed }
}

export function stripManagedCredentialConflicts(
    requested: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    const effectiveRequested = { ...requested }
    for (const key of Object.keys(managed)) delete effectiveRequested[key]
    if (managed.ANTHROPIC_BASE_URL === 'https://api.z.ai/api/anthropic') {
        // ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are in the shared list but
        // are set by the Z.AI lease itself, so the loop above already removed them.
        for (const key of CLAUDE_AUTH_OVERRIDE_ENV_KEYS) delete effectiveRequested[key]
        delete effectiveRequested.ANTHROPIC_MODEL
        delete effectiveRequested.ANTHROPIC_SMALL_FAST_MODEL
    }
    // A bound setup-token session spends only that token; the model choice stays the user's.
    if (managed.CLAUDE_CODE_OAUTH_TOKEN) {
        for (const key of CLAUDE_AUTH_OVERRIDE_ENV_KEYS) delete effectiveRequested[key]
    }
    return effectiveRequested
}

export function buildManagedSessionSpawnEnvironment(
    inherited: NodeJS.ProcessEnv,
    explicit: Record<string, string>,
    managed: Record<string, string>,
): Record<string, string> {
    return overlayManagedCredentialEnvironment(
        buildSessionSpawnEnvironment(inherited, explicit),
        managed,
    )
}

/** Retains only the per-session Saycode capability needed by a later resume. */
export function captureSaycodeAgentEnvironment(
    env: NodeJS.ProcessEnv,
): SaycodeAgentEnvironment | undefined {
    const captured: SaycodeAgentEnvironment = {}
    if (env.SAYCODE_AGENT_ENV === '1' && env.SAYCODE_AGENT_ROOT?.trim()) {
        Object.assign(captured, Object.fromEntries(
            SAYCODE_AGENT_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
        ))
    }
    // Sandbox policy belongs to every session, including sessions without agent control.
    if (env.HAPPY_PROJECT_SANDBOX_CONFIG !== undefined) {
        captured.HAPPY_PROJECT_SANDBOX_CONFIG = env.HAPPY_WRITE_SCOPE_BASE_CONFIG ?? env.HAPPY_PROJECT_SANDBOX_CONFIG
    }
    if (env.HAPPY_WRITE_SCOPE_SESSION === '1') {
        captured.HAPPY_WRITE_SCOPE_SESSION = '1'; captured.HAPPY_SANDBOX_POLICY_MODE = 'mandatory';
    }
    // Which sandbox roots were user-granted, so a resume can keep or replace exactly those.
    const additionalDirectories = env[ADDITIONAL_DIRECTORIES_ENV]
    if (additionalDirectories !== undefined && isValidAdditionalDirectories(additionalDirectories)) {
        captured[ADDITIONAL_DIRECTORIES_ENV] = additionalDirectories
    }
    // A structured session keeps its schema across a resume (claude-cli-benchmark-followups R2); the
    // runner consumes the seed again. Only a format that still parses is kept.
    const outputFormat = env[OUTPUT_FORMAT_ENV]
    if (outputFormat !== undefined && isValidOutputFormatSeed(outputFormat)) captured[OUTPUT_FORMAT_ENV] = outputFormat
    // A Studio Chat(beta) session keeps being parked across the resumes an Agent Browser attention causes.
    if (env[BROWSER_CONTINUATION_ENV] === '1') captured[BROWSER_CONTINUATION_ENV] = '1'
    const binding = env[SETUP_TOKEN_BINDING_ENV]
    // A malformed record must stay bound-but-invalid through every capture/persistence
    // path. Keep no corrupt bytes; the resume guard rejects this bounded marker.
    if (binding !== undefined) captured[SETUP_TOKEN_BINDING_ENV] = parseSetupTokenBinding(binding) ? binding : ''
    const encodedCheckpointContext = env[CHECKPOINT_CONTEXT_KEY]
    if (encodedCheckpointContext && readCheckpointSpawnContext(env)) {
        captured[CHECKPOINT_CONTEXT_KEY] = encodedCheckpointContext
    }
    return Object.keys(captured).length > 0 ? captured : undefined
}

const MANAGED_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const GROUP_SCOPE = /^[A-Za-z0-9_-]{1,128}$/
const BINDING_KEYS = ['version', 'managedAccountId', 'credentialGeneration', 'groupScope', 'companyId', 'userId', 'machineId', 'keyId', 'nonce', 'issuedAt'] as const

/**
 * The immutable, signed facts a bound session keeps: who the server said may bind
 * which managed account at which generation. No token and no grant envelope.
 */
export type UserSetupTokenBinding = {
    principalType?: 'user'
    managedAccountId: string; credentialGeneration: number; groupScope: string; companyId: string
    userId: string; machineId: string; keyId: string; nonce: string; issuedAt: number
    tokenProof?: string
}

const executionSchema = z.object({ sessionId: z.string().min(1).max(128), initialNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    issueOperationId: z.string().min(1).max(128), sessionOwnerAccountId: z.string().min(1).max(128), machineOwnerAccountId: z.string().min(1).max(128) }).strict()
export type MachineSetupTokenBindingRecord = MachineSetupTokenBindingV2 & { execution: z.infer<typeof executionSchema> }
export type SetupTokenBinding = UserSetupTokenBinding | MachineSetupTokenBindingRecord
export const isMachineSetupTokenBinding = (binding: SetupTokenBinding): binding is MachineSetupTokenBindingRecord => binding.principalType === 'machine'

export function formatSetupTokenBinding(binding: SetupTokenBinding): string {
    if (isMachineSetupTokenBinding(binding)) return JSON.stringify(binding)
    return JSON.stringify({ ...Object.fromEntries(BINDING_KEYS.map((key) => [key, key === 'version' ? 1 : binding[key]])), ...(binding.tokenProof ? { tokenProof: binding.tokenProof } : {}) })
}

/**
 * The managed account an unbound shared-PC launch spends (Saycode specs/shared-pc-session-account-continuation).
 * Daemon-written like the binding: no Studio binding exists, so the daemon moves such a session within the
 * accounts assigned to this PC.
 */
export const SETUP_TOKEN_SHARED_ACCOUNT_ENV = 'HAPPY_AI_AUTH_SETUP_TOKEN_SHARED_ACCOUNT'
const SHARED_MACHINE_AUTHORITY = 'shared-machine:'

/** The managed account an unbound shared-PC environment spends; undefined for any other environment. */
export function sharedMachineSetupTokenAccount(env: Record<string, string | undefined>): string | undefined {
    const managedAccountId = env[SETUP_TOKEN_SHARED_ACCOUNT_ENV]
    return env.HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED === '1' && !env[SETUP_TOKEN_BINDING_ENV] && managedAccountId && MANAGED_ACCOUNT_ID.test(managedAccountId)
        ? managedAccountId : undefined
}

/** What a shared-PC session reports and switches against, in place of a binding record. */
export function sharedMachineSetupTokenAuthority(env: Record<string, string | undefined>): string | undefined {
    const managedAccountId = sharedMachineSetupTokenAccount(env)
    return managedAccountId ? `${SHARED_MACHINE_AUTHORITY}${managedAccountId}` : undefined
}

/** The managed account a shared-PC authority names; undefined for a binding record or anything else. */
export function parseSharedMachineSetupTokenAuthority(value: string): string | undefined {
    const managedAccountId = value.startsWith(SHARED_MACHINE_AUTHORITY) ? value.slice(SHARED_MACHINE_AUTHORITY.length) : ''
    return MANAGED_ACCOUNT_ID.test(managedAccountId) ? managedAccountId : undefined
}

function parseSetupTokenBinding(value: string): SetupTokenBinding | null {
    try {
        if (value.length > 8192) return null
        const parsed = parseCanonicalOrgSetupTokenJson(value) as Record<string, unknown>
        if (parsed?.version === 2) {
            const { execution, ...body } = parsed
            return { ...MachineSetupTokenBindingV2Schema.parse(body), execution: executionSchema.parse(execution) }
        }
        if (parsed?.version !== 1 || BINDING_KEYS.some(key => !(key in parsed))
            || Object.keys(parsed).some(key => !(BINDING_KEYS as readonly string[]).includes(key) && key !== 'tokenProof')
            || ('tokenProof' in parsed && (typeof parsed.tokenProof !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.tokenProof)))
            || typeof parsed.managedAccountId !== 'string' || !MANAGED_ACCOUNT_ID.test(parsed.managedAccountId)
            || typeof parsed.nonce !== 'string' || !MANAGED_ACCOUNT_ID.test(parsed.nonce)
            || ![parsed.groupScope, parsed.companyId, parsed.userId, parsed.machineId].every((id) => typeof id === 'string' && GROUP_SCOPE.test(id))
            || typeof parsed.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.keyId)
            || ![parsed.credentialGeneration, parsed.issuedAt].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1)) return null
        const { version: _version, ...binding } = parsed
        return binding as SetupTokenBinding
    } catch { return null }
}

/**
 * What a resume must bind: exactly the recorded account, generation and owner. No
 * new grant is needed (the original one was verified and consumed); the journal and
 * storage are re-checked instead. A corrupt record refuses the resume.
 */
/** Set by the daemon on a resumed session it moved onto another organization account (Saycode specs/managed-account-session-continuation). */
export const SETUP_TOKEN_RESUME_REBOUND_ENV = 'HAPPY_SETUP_TOKEN_RESUME_REBOUND'

export function readSetupTokenResumeSelection(agentEnvironment: SaycodeAgentEnvironment | undefined):
    { selection: AiAuthSelection; binding: SetupTokenBinding } | undefined {
    const raw = agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]
    if (raw === undefined) return undefined
    const binding = parseSetupTokenBinding(raw)
    if (!binding) throw new Error('Recorded setup-token binding is invalid; the session is not resumed with another credential')
    const { managedAccountId, credentialGeneration, groupScope } = binding
    return { selection: { kind: 'claude-setup-token', managedAccountId, groupScope, credentialGeneration,
        ...(!isMachineSetupTokenBinding(binding) && binding.tokenProof ? { credentialProofVersion: 1 as const } : {}) }, binding }
}

function isValidAdditionalDirectories(value: string): boolean {
    try {
        readAdditionalDirectoriesEnvironment({ [ADDITIONAL_DIRECTORIES_ENV]: value })
        return true
    } catch {
        return false
    }
}

/** Restores one tracked session's capability without inheriting the caller's. */
export function buildResumedSessionSpawnEnvironment(input: {
    inherited: NodeJS.ProcessEnv
    explicit: Record<string, string>
    runtime?: Record<string, string>
    automation?: Record<string, string>
    agentEnvironment?: SaycodeAgentEnvironment
    sessionId: string
}): Record<string, string> {
    const policyKey = 'HAPPY_PROJECT_SANDBOX_CONFIG'
    // A session keeps its own policy; explicit updates still take precedence.
    const policy = input.explicit[policyKey] ?? input.automation?.[policyKey]
        ?? input.runtime?.[policyKey] ?? input.agentEnvironment?.[policyKey]
    const runtime = expandEnvironmentVariables(
        sanitizeChildEnv(stripUnsafeRequestedEnvironment(input.runtime ?? {})),
    )
    const automation = expandEnvironmentVariables(
        sanitizeChildEnv(stripUnsafeRequestedEnvironment(input.automation ?? {})),
    )
    return buildSessionSpawnEnvironment({ ...input.inherited, [policyKey]: undefined }, {
        // runtime (the resume request) and automation environments are request-supplied too.
        ...runtime,
        ...automation,
        ...input.explicit,
        ...(input.agentEnvironment ?? {}),
        ...(policy !== undefined ? { [policyKey]: policy } : {}),
        APLUS_SESSION_ID: input.sessionId,
    })
}

/**
 * Writes down which credential a **final** child environment actually spends.
 *
 * Applied to the finished environment on purpose. The managed credential is
 * overlaid last (`overlayManagedCredentialEnvironment`), so a decision taken
 * any earlier would record the credential the child never got to use.
 *
 * The value is the daemon's to decide because the child cannot: a managed
 * lease and a person's own key reach it as the same variables. What the daemon
 * cannot name is left `unknown` — never guessed. Writing an unestablished
 * source down as a personal subscription meters the run against somebody's own
 * plan.
 */
export function applyAppliedAiAuthSourceEnv(
    env: Record<string, string>,
    /**
     * The daemon applied the platform's leased GLM credential to this spawn —
     * `resolveManagedAiCredentialEnvironment` returned something. Only the
     * daemon can say this: a person's own GLM key reaches the child through the
     * same Z.AI variables, so the environment alone never proves ownership.
     */
    platformLeaseApplied = false,
): Record<string, string> {
    /*
     * The version is **written empty, not omitted**.
     *
     * tmux only applies the keys it is handed (`-e KEY=VALUE`); a key left out
     * stays in the tmux server environment and is inherited by the next child.
     * Deleting it from this object therefore clears it on a plain spawn and
     * leaves it standing on the tmux path, where an earlier session's version
     * would pair with this session's freshly written source. Writing it empty
     * overwrites on both paths, and `readAiAuthConnectionVersion` reads an
     * empty string as "no version" — only a managed run writes a real one
     * (`applyManagedAiAuthReporting`).
     */
    return {
        ...env,
        [HAPPY_AI_AUTH_SOURCE_ENV]: resolveAppliedAiAuthSource({ env, platformLeaseApplied }),
        [HAPPY_AI_AUTH_CONNECTION_VERSION_ENV]: '',
    }
}

/**
 * Sets or removes the confirmed-delivery switch on a **final** child
 * environment.
 *
 * Applied after the merge because the daemon's own environment is inherited
 * wholesale on the default path: deleting the key from the caller's extras is
 * not enough, since a value already present in `process.env` would survive the
 * merge and turn the switch on for a launch that never asked for it.
 *
 * The switch changes delivery behaviour only. It is not an identity and grants
 * no permission.
 */
export function applyConfirmedPromptDeliveryFlag(
    env: Record<string, string>,
    required: boolean,
): Record<string, string> {
    if (required) return { ...env, HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' }
    const { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: _removed, ...rest } = env
    return rest
}

/**
 * Which credential the requester explicitly chose for **one** BYOS spawn.
 *
 * Two kinds only, and the set is closed. A value outside it is rejected rather
 * than ignored: a silently dropped selection runs the session on whatever the
 * machine would have used anyway, which is the outcome the person was trying
 * to avoid by choosing.
 */
export const AI_AUTH_SELECTION_KINDS = ['machine-personal', 'org-bundle', 'claude-setup-token'] as const

export type AiAuthSelectionKind = (typeof AI_AUTH_SELECTION_KINDS)[number]

/**
 * `claude-setup-token` pins one new Claude session to an organisation-managed
 * setup-token slot. Older daemons reject the kind, so a client gates it on
 * `ai-credential:capabilities.newSessionProfileBinding`.
 */
export type AiAuthSelection =
    | { kind: 'machine-personal' | 'org-bundle' }
    /** `bindingGrant` is required on a new spawn; a resume rebuilds the selection from the recorded binding. */
    | { kind: 'claude-setup-token'; managedAccountId: string; groupScope: string; credentialGeneration: number; bindingGrant?: string; credentialProofVersion?: 1 }

/**
 * Advertised in `MachineMetadataSchema` so a client can tell this daemon
 * understands the selection *before* sending one. `spawn-happy-session`
 * destructures its parameters, so an older daemon drops an unknown field
 * without a word — the version says which kinds the daemon knows, which the
 * mere presence of a field cannot.
 */
export const AI_AUTH_SELECTION_CAPABILITY = { version: 1 as const }

/** Rejects anything outside the closed set, following the spawn-parameter convention. */
export function parseAiAuthSelection(value: unknown): AiAuthSelection | undefined {
    if (value === undefined) return undefined
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('AI auth selection must be an object')
    }
    const kind = (value as { kind?: unknown }).kind
    if (typeof kind !== 'string' || !(AI_AUTH_SELECTION_KINDS as readonly string[]).includes(kind)) {
        throw new Error(
            `AI auth selection kind must be one of: ${AI_AUTH_SELECTION_KINDS.join(', ')}`,
        )
    }
    if (kind === 'claude-setup-token') {
        const managedAccountId = (value as { managedAccountId?: unknown }).managedAccountId
        if (typeof managedAccountId !== 'string'
            || !MANAGED_ACCOUNT_ID.test(managedAccountId)) {
            throw new Error('AI auth selection claude-setup-token requires a managedAccountId')
        }
        // The group-sync scope (company) whose daemon journal must own the slot.
        const groupScope = (value as { groupScope?: unknown }).groupScope
        if (typeof groupScope !== 'string' || !GROUP_SCOPE.test(groupScope)) {
            throw new Error('AI auth selection claude-setup-token requires a groupScope')
        }
        const credentialGeneration = (value as { credentialGeneration?: unknown }).credentialGeneration
        if (!Number.isSafeInteger(credentialGeneration) || Number(credentialGeneration) < 1) {
            throw new Error('AI auth selection credentialGeneration must be a positive integer')
        }
        // The server-signed proof; verified, matched and consumed by the daemon, never persisted.
        const bindingGrant = (value as { bindingGrant?: unknown }).bindingGrant
        if (typeof bindingGrant !== 'string' || bindingGrant.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bindingGrant)) {
            throw new Error('AI auth selection claude-setup-token requires a bindingGrant')
        }
        const credentialProofVersion = (value as { credentialProofVersion?: unknown }).credentialProofVersion
        if (credentialProofVersion !== undefined && credentialProofVersion !== 1) throw new Error('Unsupported setup-token credential proof version')
        return { kind, managedAccountId, groupScope, credentialGeneration: Number(credentialGeneration), bindingGrant,
            ...(credentialProofVersion === 1 ? { credentialProofVersion } : {}) }
    }
    return { kind: kind as 'machine-personal' | 'org-bundle' }
}

/**
 * Whether the daemon still overlays its own managed credential on this spawn.
 *
 * `machine-personal` means "this machine's own login", so the daemon must not
 * put its managed credential on top — `overlayManagedCredentialEnvironment`
 * applies last and would otherwise always win. Without a selection nothing
 * changes.
 */
/*
 * Not the unbound-default guard: an explicit `machine-personal` selection is a deliberate escape
 * from managed credentials (and is then held to the applied-source proof). The setup-token guard
 * in the AI credential runtime only applies to launches that name no selection.
 */
export function honorsManagedAiCredentials(selection: AiAuthSelection | undefined): boolean {
    return selection?.kind !== 'machine-personal'
}

/** A source the daemon applied itself — never the machine's own login. */
const DAEMON_APPLIED_AI_AUTH_SOURCES: readonly AiAuthSource[] = [
    'org-bundle',
    'platform-glm',
    'platform-gateway',
]

export type AiAuthSelectionVerdict = {
    /** What the finished environment says this spawn actually spends. */
    appliedSource: AiAuthSource
    /** Set when the spawn must not run; the text is shown to the requester. */
    rejection?: string
}

/**
 * Compares an explicit selection against what the daemon can **prove** about
 * the credential this spawn will spend.
 *
 * An earlier revision accepted `machine-personal` on a negative confirmation —
 * "the daemon overlaid nothing of its own". That reasoning was wrong, and
 * three things it cannot see prove it:
 *
 *  - an `ANTHROPIC_API_KEY` inherited from the daemon's own environment, or
 *    injected by the project, is somebody's credential and leaves the check
 *    untouched;
 *  - an organisation Claude bundle is installed by `cswap` into machine-global
 *    files and reaches no environment variable at all — worse, `cswap import`
 *    **removes every account not in the bundle**, so on such a machine the
 *    personal login the selection names does not exist any more;
 *  - a gateway token and base URL left by any earlier layer look the same.
 *
 * All three ran green against the old rule. "I added nothing" is not "the run
 * spends your own login": it is the absence of one kind of evidence, not the
 * presence of another. Passing it silently is the failure this feature exists
 * to prevent — a selected session metered against a credential the user did
 * not choose.
 *
 * So both kinds now require a **positive** statement that the daemon applied
 * the named credential. Today no code path produces one for either kind, so
 * every explicit selection is refused. That is the state of the evidence, not
 * a special case: when a path does write `HAPPY_AI_AUTH_SOURCE` from a proven
 * application, the same comparison starts passing with no change here.
 */
export function verifyAiAuthSelection(
    selection: AiAuthSelection | undefined,
    env: Record<string, string>,
): AiAuthSelectionVerdict {
    const appliedSource = normalizeAiAuthSource(env[HAPPY_AI_AUTH_SOURCE_ENV])
    if (selection === undefined) return { appliedSource }
    if (appliedSource === selectionAppliedSource(selection.kind)) return { appliedSource }
    return {
        appliedSource,
        rejection: `AI auth selection '${selection.kind}' was requested but this daemon could not`
            + ` confirm that credential for the spawn (applied source: '${appliedSource}').`
            + ` The session is not started with a substitute credential.`,
    }
}

/** The applied source that would prove a selection was honoured. */
function selectionAppliedSource(kind: AiAuthSelectionKind): AiAuthSource {
    return kind === 'org-bundle' || kind === 'claude-setup-token' ? 'org-bundle' : 'personal-subscription'
}
