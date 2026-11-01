/**
 * aplus-dev-studio specs/org-agent-plan §6.3-2 — the organization agent plan launch contract between the daemon
 * and the `happy codex` runner.
 *
 * The daemon opens the grant envelope and hands the runner a **descriptor** (which Studio, which grant, which
 * model, that model's context settings) and the grant secret, through the spawn-seed prefix `HAPPY_INITIAL_`.
 * `sanitizeChildEnv(..., { boundary: 'in-session' })` drops that prefix, so neither reaches Codex or the
 * agent's shells. The runner rebuilds the descriptor from its parts and refuses anything that is not exactly
 * what this module would have written — there is no signature (a tampered descriptor only affects the user's
 * own session, and cost is enforced by the server ledger), but the canonical check keeps the secret from being
 * sent anywhere but the runner's own trusted Studio origin, and keeps the context settings the gateway meters
 * against.
 */
import { readTrustedStudioOrigin } from '@/daemon/setupTokenBindingProof'

/** Advertised in machine metadata as `agentPlan`. Only macOS/Linux daemons publish it (spec §6.3-5). */
export const AGENT_PLAN_CAPABILITY = { version: 1 as const }

/** Spawn seeds: read and deleted by the runner, never inherited (childEnv `HAPPY_INITIAL_`). */
export const AGENT_PLAN_DESCRIPTOR_ENV = 'HAPPY_INITIAL_AGENT_PLAN_DESCRIPTOR'
export const AGENT_PLAN_SECRET_ENV = 'HAPPY_INITIAL_AGENT_PLAN_SECRET'

/**
 * The one value of the plan that reaches Codex: the runner's local proxy client key. It opens only that
 * proxy, never the gateway, and is session-scoped (childEnv `HAPPY_AGENT_PLAN_`).
 */
export const AGENT_PLAN_PROXY_KEY_ENV = 'HAPPY_AGENT_PLAN_PROXY_KEY'

export const AGENT_PLAN_PROVIDER_ID = 'saycode-plan'

export const AGENT_PLAN_DESCRIPTOR_VERSION = 1

/**
 * Plan models and their Codex context settings. The window matches the gateway's per-model input cap
 * (web-ui `AGENT_PLAN_MODEL_CAPS`); compaction leaves room for instructions and tool definitions.
 */
const AGENT_PLAN_MODEL_CONTEXT = {
    'gpt-6-luna': { contextWindow: 128000, autoCompactTokenLimit: 100000 },
    'gpt-6.1-terra': { contextWindow: 128000, autoCompactTokenLimit: 100000 },
    'gpt-6.1-sol': { contextWindow: 64000, autoCompactTokenLimit: 48000 },
    'gpt-6-astra': { contextWindow: 64000, autoCompactTokenLimit: 48000 },
} as const

export type AgentPlanModel = keyof typeof AGENT_PLAN_MODEL_CONTEXT

export type AgentPlanDescriptor = {
    version: typeof AGENT_PLAN_DESCRIPTOR_VERSION
    origin: string
    grantId: string
    model: AgentPlanModel
    contextWindow: number
    autoCompactTokenLimit: number
}

export type AgentPlanErrorCode =
    | 'agent_plan_descriptor_invalid'
    | 'agent_plan_session_unavailable'
    | 'agent_plan_bind_failed'
    | 'agent_plan_proxy_failed'
    | 'agent_plan_managed_conflict'
    | 'agent_plan_not_applied'

/** A plan launch that cannot go ahead. The runner exits with it; the session never runs on another credential. */
export class AgentPlanLaunchError extends Error {
    constructor(readonly code: AgentPlanErrorCode, detail?: string) {
        super(detail ? `${code}: ${detail}` : code)
        this.name = 'AgentPlanLaunchError'
    }
}

const GRANT_ID = /^[A-Za-z0-9-]{1,200}$/

export function isAgentPlanModel(value: unknown): value is AgentPlanModel {
    return typeof value === 'string' && Object.hasOwn(AGENT_PLAN_MODEL_CONTEXT, value)
}

export function isAgentPlanGrantId(value: unknown): value is string {
    return typeof value === 'string' && GRANT_ID.test(value)
}

/** The descriptor for a grant, or `null` when any part is outside the contract. */
export function buildAgentPlanDescriptor(input: { origin: string; grantId: string; model: string }): AgentPlanDescriptor | null {
    const origin = readTrustedStudioOrigin({ HAPPY_APLUS_STUDIO_ORIGIN: input.origin })
    if (!origin || origin !== input.origin) return null
    if (!isAgentPlanGrantId(input.grantId) || !isAgentPlanModel(input.model)) return null
    return {
        version: AGENT_PLAN_DESCRIPTOR_VERSION,
        origin,
        grantId: input.grantId,
        model: input.model,
        ...AGENT_PLAN_MODEL_CONTEXT[input.model],
    }
}

/** Fixed key order: the runner compares the text, not a parsed copy. */
export function serializeAgentPlanDescriptor(descriptor: AgentPlanDescriptor): string {
    return JSON.stringify({
        version: descriptor.version,
        origin: descriptor.origin,
        grantId: descriptor.grantId,
        model: descriptor.model,
        contextWindow: descriptor.contextWindow,
        autoCompactTokenLimit: descriptor.autoCompactTokenLimit,
    })
}

/**
 * The runner's read: rebuilt from its parts with this module's rules and compared as text, and the origin must
 * be the runner's own trusted Studio origin. Anything else throws — a runner that cannot honour the plan does
 * not start rather than run on the machine's own Codex login.
 */
export function readAgentPlanDescriptor(raw: string, trustedOrigin: string | null): AgentPlanDescriptor {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new AgentPlanLaunchError('agent_plan_descriptor_invalid', 'unreadable')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new AgentPlanLaunchError('agent_plan_descriptor_invalid', 'not an object')
    }
    const fields = parsed as Record<string, unknown>
    if (!trustedOrigin || fields.origin !== trustedOrigin) {
        throw new AgentPlanLaunchError('agent_plan_descriptor_invalid', 'origin is not this runner\'s Studio')
    }
    const rebuilt = buildAgentPlanDescriptor({
        origin: trustedOrigin,
        grantId: String(fields.grantId),
        model: String(fields.model),
    })
    if (!rebuilt || serializeAgentPlanDescriptor(rebuilt) !== raw) {
        throw new AgentPlanLaunchError('agent_plan_descriptor_invalid', 'not the descriptor this contract writes')
    }
    return rebuilt
}

export function agentPlanSessionKeysUrl(descriptor: AgentPlanDescriptor): string {
    return `${descriptor.origin}/api/agent-plan/session-keys`
}

export function agentPlanGatewayResponsesUrl(descriptor: AgentPlanDescriptor): string {
    return `${descriptor.origin}/api/agent-plan/v1/responses`
}

/**
 * The Codex arguments for a plan session (spec §6.3-2), each value one `-c` argument.
 *
 * `web_search="disabled"` is the top-level key: on Codex 0.162.1 it removes the hosted `web_search` tool from
 * the request, while `tools.web_search=false` parses but leaves the tool in place (checked against a local fake
 * provider). The gateway refuses hosted tools, so a left-in tool would fail every turn.
 * `disable_response_storage` is not a key Codex 0.162.1 knows (unknown keys are ignored); it is kept because the
 * spec lists it, and the request carries `store:false` regardless.
 */
export function agentPlanCodexArgs(descriptor: AgentPlanDescriptor, proxyBaseUrl: string): string[] {
    const provider = `model_providers.${AGENT_PLAN_PROVIDER_ID}`
    return [
        '-c', `model_provider="${AGENT_PLAN_PROVIDER_ID}"`,
        '-c', `${provider}.name="Saycode plan"`,
        '-c', `${provider}.base_url=${JSON.stringify(proxyBaseUrl)}`,
        '-c', `${provider}.wire_api="responses"`,
        '-c', `${provider}.requires_openai_auth=false`,
        '-c', `${provider}.env_key="${AGENT_PLAN_PROXY_KEY_ENV}"`,
        '-c', `model=${JSON.stringify(descriptor.model)}`,
        '-c', `model_context_window=${descriptor.contextWindow}`,
        '-c', `model_auto_compact_token_limit=${descriptor.autoCompactTokenLimit}`,
        '-c', 'disable_response_storage=true',
        '-c', 'web_search="disabled"',
    ]
}
