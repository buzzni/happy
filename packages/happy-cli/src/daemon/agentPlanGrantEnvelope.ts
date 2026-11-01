/**
 * aplus-dev-studio specs/org-agent-plan §6.3-1·§6.3-2 — the daemon's side of an organization agent plan spawn.
 *
 * The Studio seals the grant to this machine's MCP caller grant key (the same key pair and byte layout as the
 * MCP caller grant envelope), so a browser cannot read the grant secret and no other machine can open it. The
 * daemon checks machine, expiry and one-time use, then hands the runner a descriptor and the secret as spawn
 * seeds. It reports nothing about the source: only the runner knows when the plan provider actually reached
 * Codex (spec §6.3-3).
 */
import { createHash } from 'node:crypto'
import tweetnacl from 'tweetnacl'
import {
    AGENT_PLAN_CAPABILITY,
    AGENT_PLAN_DESCRIPTOR_ENV,
    AGENT_PLAN_SECRET_ENV,
    buildAgentPlanDescriptor,
    isAgentPlanGrantId,
    isAgentPlanModel,
    serializeAgentPlanDescriptor,
    type AgentPlanModel,
} from '@/launcher/agentPlanLaunch'
import { openSealedGrantEnvelope } from './mcpCallerGrantEnvelope'

const MAX_ENVELOPE_CHARS = 16 * 1024
const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_REPLAY_ENTRIES = 4_096
const SECRET = /^[A-Za-z0-9_-]{16,200}$/
const PLAINTEXT_KEYS = ['version', 'kind', 'grantId', 'secret', 'machineId', 'model', 'expiresAt'] as const

export type AgentPlanSpawnRefusal =
    | 'agent_plan_agent_unsupported'
    | 'agent_plan_conflicting_selection'
    | 'agent_plan_unavailable'
    | 'agent_plan_envelope_invalid'
    | 'agent_plan_wrong_machine'
    | 'agent_plan_envelope_expired'
    | 'agent_plan_envelope_replayed'
    | 'agent_plan_capacity'

export type AgentPlanGrant = { grantId: string; secret: string; model: AgentPlanModel; expiresAt: number }

export type AgentPlanSpawnParam = { grantEnvelope: string }

/** `undefined` on Windows: the plan path is designed for macOS/Linux daemons only (spec §6.3-5). */
export function agentPlanCapabilityForPlatform(platform: NodeJS.Platform): typeof AGENT_PLAN_CAPABILITY | undefined {
    return platform === 'win32' ? undefined : AGENT_PLAN_CAPABILITY
}

/**
 * The spawn RPC field. Any shape but `{ grantEnvelope }` throws: dropping it would start the session on the
 * machine's own Codex login while the user chose the plan.
 */
export function parseAgentPlanSpawnParam(value: unknown): AgentPlanSpawnParam | undefined {
    if (value === undefined) return undefined
    if (
        !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== 1
        || typeof (value as { grantEnvelope?: unknown }).grantEnvelope !== 'string'
    ) {
        throw new Error('Agent plan must be { grantEnvelope: string }')
    }
    const grantEnvelope = (value as AgentPlanSpawnParam).grantEnvelope
    if (!grantEnvelope || grantEnvelope.length > MAX_ENVELOPE_CHARS) {
        throw new Error('Agent plan grant envelope must be a non-empty string of at most 16 KiB')
    }
    return { grantEnvelope }
}

function parsePlaintext(plaintext: Uint8Array): (AgentPlanGrant & { machineId: string }) | null {
    let value: unknown
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    } catch {
        return null
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const fields = value as Record<string, unknown>
    const keys = Object.keys(fields)
    if (keys.length !== PLAINTEXT_KEYS.length || PLAINTEXT_KEYS.some((key) => !keys.includes(key))) return null
    if (fields.version !== 1 || fields.kind !== 'agent-plan-grant') return null
    if (!isAgentPlanGrantId(fields.grantId) || typeof fields.secret !== 'string' || !SECRET.test(fields.secret)) return null
    if (typeof fields.machineId !== 'string' || !fields.machineId || !isAgentPlanModel(fields.model)) return null
    if (typeof fields.expiresAt !== 'number' || !Number.isSafeInteger(fields.expiresAt)) return null
    return {
        grantId: fields.grantId,
        secret: fields.secret,
        machineId: fields.machineId,
        model: fields.model,
        expiresAt: fields.expiresAt,
    }
}

/**
 * Opens plan grant envelopes addressed to this machine and keeps each grant to one spawn. The server stays the
 * authority on the grant (it binds the first session id atomically); this layer stops an observed RPC payload
 * from starting a second local runner that would race the first to bind.
 */
export class AgentPlanGrantEnvelopeConsumer {
    private readonly consumed = new Map<string, number>()
    private readonly now: () => number
    private readonly maxEntries: number

    constructor(private readonly options: {
        machineId: string
        secretKey: Uint8Array
        now?: () => number
        maxEntries?: number
    }) {
        if (options.secretKey.length !== tweetnacl.box.secretKeyLength) {
            throw new Error('Agent plan grant secret key must be 32 bytes')
        }
        this.now = options.now ?? Date.now
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_REPLAY_ENTRIES
    }

    /**
     * Opens and checks an envelope **without** using it up. A spawn that is refused afterwards for an unrelated
     * reason (an unreadable MCP envelope after a key rotation, say) is retried by web-ui and Desktop with the same
     * params, so the grant may only be spent by {@link claim} when the child is actually launched.
     */
    open(envelope: string): { ok: true; grant: AgentPlanGrant } | { ok: false; reason: AgentPlanSpawnRefusal } {
        const plaintext = openSealedGrantEnvelope(envelope, this.options.secretKey)
        const grant = plaintext ? parsePlaintext(plaintext) : null
        if (!grant) return { ok: false, reason: 'agent_plan_envelope_invalid' }
        if (grant.machineId !== this.options.machineId) return { ok: false, reason: 'agent_plan_wrong_machine' }
        const now = this.now()
        if (grant.expiresAt < now) return { ok: false, reason: 'agent_plan_envelope_expired' }
        if (grant.expiresAt - now > MAX_GRANT_TTL_MS) return { ok: false, reason: 'agent_plan_envelope_invalid' }
        this.prune(now)
        if (this.consumed.has(replayKey(grant.grantId))) return { ok: false, reason: 'agent_plan_envelope_replayed' }
        return { ok: true, grant: { grantId: grant.grantId, secret: grant.secret, model: grant.model, expiresAt: grant.expiresAt } }
    }

    /** Spends an opened grant. Re-checked here, so two concurrent spawns of one envelope launch one child. */
    claim(grant: Pick<AgentPlanGrant, 'grantId' | 'expiresAt'>): AgentPlanSpawnRefusal | null {
        this.prune(this.now())
        const key = replayKey(grant.grantId)
        if (this.consumed.has(key)) return 'agent_plan_envelope_replayed'
        if (this.consumed.size >= this.maxEntries) return 'agent_plan_capacity'
        this.consumed.set(key, grant.expiresAt)
        return null
    }

    /** {@link open} then {@link claim}. */
    consume(envelope: string): { ok: true; grant: AgentPlanGrant } | { ok: false; reason: AgentPlanSpawnRefusal } {
        const opened = this.open(envelope)
        if (!opened.ok) return opened
        const refusal = this.claim(opened.grant)
        return refusal ? { ok: false, reason: refusal } : opened
    }

    private prune(now: number): void {
        for (const [key, expiresAt] of this.consumed) {
            if (expiresAt < now) this.consumed.delete(key)
        }
    }
}

function replayKey(grantId: string): string {
    return createHash('sha256').update(grantId).digest('base64url')
}

/**
 * The spawn seeds for a plan launch, or the refusal. Nothing is spent here: the caller runs `claim()` right
 * before it launches the child, after every other reason to refuse the spawn has been checked.
 */
export function prepareAgentPlanLaunch(
    input: {
        agentPlan?: AgentPlanSpawnParam
        agent?: string
        aiAuthSelection?: unknown
        platform: NodeJS.Platform
        /** The daemon's trusted Studio origin; the runner exchanges the grant only there. */
        studioOrigin: string | null
    },
    consumer: Pick<AgentPlanGrantEnvelopeConsumer, 'open' | 'claim'>,
): { ok: true; environment: Record<string, string>; claim: () => AgentPlanSpawnRefusal | null }
    | { ok: false; reason: AgentPlanSpawnRefusal } {
    if (!input.agentPlan) return { ok: true, environment: {}, claim: () => null }
    if (input.agent !== 'codex') return { ok: false, reason: 'agent_plan_agent_unsupported' }
    if (input.aiAuthSelection !== undefined) return { ok: false, reason: 'agent_plan_conflicting_selection' }
    if (!agentPlanCapabilityForPlatform(input.platform) || !input.studioOrigin) return { ok: false, reason: 'agent_plan_unavailable' }
    const opened = consumer.open(input.agentPlan.grantEnvelope)
    if (!opened.ok) return opened
    const descriptor = buildAgentPlanDescriptor({
        origin: input.studioOrigin,
        grantId: opened.grant.grantId,
        model: opened.grant.model,
    })
    if (!descriptor) return { ok: false, reason: 'agent_plan_unavailable' }
    const grant = opened.grant
    return {
        ok: true,
        environment: {
            [AGENT_PLAN_DESCRIPTOR_ENV]: serializeAgentPlanDescriptor(descriptor),
            [AGENT_PLAN_SECRET_ENV]: grant.secret,
        },
        claim: () => consumer.claim(grant),
    }
}
