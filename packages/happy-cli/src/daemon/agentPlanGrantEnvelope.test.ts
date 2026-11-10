import { describe, expect, it } from 'vitest'
import tweetnacl from 'tweetnacl'
import { encodeBase64, libsodiumEncryptForPublicKey } from '@/api/encryption'
import {
    AGENT_PLAN_DESCRIPTOR_ENV,
    AGENT_PLAN_SECRET_ENV,
    readAgentPlanDescriptor,
} from '@/launcher/agentPlanLaunch'
import {
    AgentPlanGrantEnvelopeConsumer,
    agentPlanCapabilityForPlatform,
    parseAgentPlanSpawnParam,
    prepareAgentPlanLaunch,
} from './agentPlanGrantEnvelope'

const ORIGIN = 'https://saycode.ai'
const GRANT = '3f1c2a4e-1b2c-4d5e-8f90-123456789abc'
const SECRET = 'c2VjcmV0LXZhbHVlLWZvci10aGUtZ3JhbnQtMzItYnl0ZXM'
const NOW = 1_800_000_000_000

function plaintext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: 1,
        kind: 'agent-plan-grant',
        grantId: GRANT,
        secret: SECRET,
        machineId: 'M-1',
        model: 'gpt-6-luna',
        expiresAt: NOW + 10 * 60_000,
        ...overrides,
    }
}

/** The Studio's `sealedGrantResponse`: encryptBox(JSON) to the machine's grant public key, standard base64. */
function seal(value: unknown, publicKey: Uint8Array): string {
    return encodeBase64(libsodiumEncryptForPublicKey(new TextEncoder().encode(JSON.stringify(value)), publicKey))
}

function setup() {
    const keyPair = tweetnacl.box.keyPair()
    const consumer = new AgentPlanGrantEnvelopeConsumer({ machineId: 'M-1', secretKey: keyPair.secretKey, now: () => NOW })
    return { keyPair, consumer }
}

describe('agentPlan capability', () => {
    // aplus-dev-studio specs/agent-plan-full-capability R4 — the grant path no longer needs a named pipe: the token
    // travels through a 127.0.0.1 TCP proxy, which Windows has, so Windows daemons publish the plan too.
    it('is published on macOS, Linux and Windows daemons', () => {
        expect(agentPlanCapabilityForPlatform('darwin')).toEqual({ version: 1 })
        expect(agentPlanCapabilityForPlatform('linux')).toEqual({ version: 1 })
        expect(agentPlanCapabilityForPlatform('win32')).toEqual({ version: 1 })
    })
})

describe('parseAgentPlanSpawnParam', () => {
    it('is absent when the spawn carries no plan', () => {
        expect(parseAgentPlanSpawnParam(undefined)).toBeUndefined()
    })

    it('accepts exactly { grantEnvelope }', () => {
        expect(parseAgentPlanSpawnParam({ grantEnvelope: 'abc=' })).toEqual({ grantEnvelope: 'abc=' })
    })

    it('throws on any other shape instead of dropping the plan silently', () => {
        expect(() => parseAgentPlanSpawnParam({ grantEnvelope: '' })).toThrow(/agent plan/i)
        expect(() => parseAgentPlanSpawnParam({ grantEnvelope: 'a', extra: 1 })).toThrow(/agent plan/i)
        expect(() => parseAgentPlanSpawnParam('abc')).toThrow(/agent plan/i)
        expect(() => parseAgentPlanSpawnParam(null)).toThrow(/agent plan/i)
    })
})

describe('AgentPlanGrantEnvelopeConsumer', () => {
    it('opens a Studio-sealed grant for this machine', () => {
        const { keyPair, consumer } = setup()
        expect(consumer.consume(seal(plaintext(), keyPair.publicKey))).toEqual({
            ok: true,
            grant: { grantId: GRANT, secret: SECRET, model: 'gpt-6-luna', expiresAt: NOW + 10 * 60_000 },
        })
    })

    it('refuses an envelope sealed to another machine key', () => {
        const { consumer } = setup()
        const other = tweetnacl.box.keyPair()
        expect(consumer.consume(seal(plaintext(), other.publicKey))).toEqual({ ok: false, reason: 'agent_plan_envelope_invalid' })
    })

    it('refuses a grant minted for another machine', () => {
        const { keyPair, consumer } = setup()
        expect(consumer.consume(seal(plaintext({ machineId: 'M-2' }), keyPair.publicKey)))
            .toEqual({ ok: false, reason: 'agent_plan_wrong_machine' })
    })

    it('refuses an expired grant', () => {
        const { keyPair, consumer } = setup()
        expect(consumer.consume(seal(plaintext({ expiresAt: NOW - 1 }), keyPair.publicKey)))
            .toEqual({ ok: false, reason: 'agent_plan_envelope_expired' })
    })

    it('refuses an expiry implausibly far away', () => {
        const { keyPair, consumer } = setup()
        expect(consumer.consume(seal(plaintext({ expiresAt: NOW + 2 * 24 * 60 * 60_000 }), keyPair.publicKey)))
            .toEqual({ ok: false, reason: 'agent_plan_envelope_invalid' })
    })

    it('uses an envelope once: a replayed RPC payload cannot start a second session', () => {
        const { keyPair, consumer } = setup()
        const envelope = seal(plaintext(), keyPair.publicKey)
        expect(consumer.consume(envelope).ok).toBe(true)
        expect(consumer.consume(envelope)).toEqual({ ok: false, reason: 'agent_plan_envelope_replayed' })
        // A second sealing of the same grant is the same grant.
        expect(consumer.consume(seal(plaintext(), keyPair.publicKey))).toEqual({ ok: false, reason: 'agent_plan_envelope_replayed' })
    })

    it('does not burn the grant when the envelope is refused for another reason', () => {
        const { keyPair, consumer } = setup()
        expect(consumer.consume(seal(plaintext({ model: 'gpt-5' }), keyPair.publicKey)).ok).toBe(false)
        expect(consumer.consume(seal(plaintext(), keyPair.publicKey)).ok).toBe(true)
    })

    it.each([
        ['wrong kind', { kind: 'mcp-caller-grant' }],
        ['wrong version', { version: 2 }],
        ['unknown model', { model: 'gpt-5' }],
        ['malformed grant id', { grantId: '../x' }],
        ['empty secret', { secret: '' }],
        ['non-numeric expiry', { expiresAt: '2030-01-01' }],
        ['an extra claim', { userId: 'U-1' }],
    ])('refuses %s', (_label, overrides) => {
        const { keyPair, consumer } = setup()
        expect(consumer.consume(seal(plaintext(overrides), keyPair.publicKey)))
            .toEqual({ ok: false, reason: 'agent_plan_envelope_invalid' })
    })

    it('refuses an MCP caller grant envelope (opaque token, not plan JSON)', () => {
        const { keyPair, consumer } = setup()
        const mcpGrant = encodeBase64(libsodiumEncryptForPublicKey(new TextEncoder().encode('payload.signature'), keyPair.publicKey))
        expect(consumer.consume(mcpGrant)).toEqual({ ok: false, reason: 'agent_plan_envelope_invalid' })
    })
})

describe('prepareAgentPlanLaunch', () => {
    const base = { agent: 'codex', platform: 'darwin' as NodeJS.Platform, studioOrigin: ORIGIN, threadsDir: '/daemon-home/agent-plan-threads', isPlanThread: (_threadId: string) => false }

    it('adds nothing when the spawn has no plan', () => {
        const { consumer } = setup()
        const result = prepareAgentPlanLaunch({ ...base }, consumer)
        expect(result).toMatchObject({ ok: true, environment: {} })
        expect(result.ok && result.claim()).toBeNull()
    })

    it('hands the runner the canonical descriptor and the secret as spawn seeds', () => {
        const { keyPair, consumer } = setup()
        const result = prepareAgentPlanLaunch({ ...base, agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) } }, consumer)
        if (!result.ok) throw new Error(result.reason)
        expect(Object.keys(result.environment).sort()).toEqual([AGENT_PLAN_DESCRIPTOR_ENV, AGENT_PLAN_SECRET_ENV, 'HAPPY_INITIAL_AGENT_PLAN_THREADS_DIR'].sort())
        expect(result.environment.HAPPY_INITIAL_AGENT_PLAN_THREADS_DIR).toBe('/daemon-home/agent-plan-threads')
        expect(result.environment[AGENT_PLAN_SECRET_ENV]).toBe(SECRET)
        // The runner's own canonical read accepts it.
        expect(readAgentPlanDescriptor(result.environment[AGENT_PLAN_DESCRIPTOR_ENV]!, ORIGIN)).toMatchObject({
            grantId: GRANT, model: 'gpt-6-luna', contextWindow: 128000,
        })
    })

    it('refuses a plan for an agent other than Codex', () => {
        const { keyPair, consumer } = setup()
        expect(prepareAgentPlanLaunch({ ...base, agent: 'claude', agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) } }, consumer))
            .toEqual({ ok: false, reason: 'agent_plan_agent_unsupported' })
    })

    it('refuses a plan combined with an AI credential selection', () => {
        const { keyPair, consumer } = setup()
        expect(prepareAgentPlanLaunch({
            ...base, aiAuthSelection: { kind: 'machine-personal' }, agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) },
        }, consumer)).toEqual({ ok: false, reason: 'agent_plan_conflicting_selection' })
    })

    it('accepts a plan launch on Windows', () => {
        const { keyPair, consumer } = setup()
        expect(prepareAgentPlanLaunch({ ...base, platform: 'win32', agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) } }, consumer))
            .toMatchObject({ ok: true })
    })

    it('refuses without a trusted Studio origin to exchange the grant with', () => {
        const { keyPair, consumer } = setup()
        expect(prepareAgentPlanLaunch({ ...base, studioOrigin: null, agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) } }, consumer))
            .toEqual({ ok: false, reason: 'agent_plan_unavailable' })
    })

    it('passes the envelope refusal through', () => {
        const { keyPair, consumer } = setup()
        expect(prepareAgentPlanLaunch({ ...base, agentPlan: { grantEnvelope: seal(plaintext({ machineId: 'M-9' }), keyPair.publicKey) } }, consumer))
            .toEqual({ ok: false, reason: 'agent_plan_wrong_machine' })
    })

    it('does not spend the grant until the caller claims it: a refused spawn can be retried with the same params', () => {
        const { keyPair, consumer } = setup()
        const params = { ...base, agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) } }
        // First attempt: prepared, then the spawn is refused for an unrelated reason (no claim).
        expect(prepareAgentPlanLaunch(params, consumer).ok).toBe(true)
        // The client's retry with the identical envelope proceeds and launches.
        const retry = prepareAgentPlanLaunch(params, consumer)
        if (!retry.ok) throw new Error(retry.reason)
        expect(retry.claim()).toBeNull()
        // Once launched, the same envelope is a replay — at preparation and at claim time.
        expect(prepareAgentPlanLaunch(params, consumer)).toEqual({ ok: false, reason: 'agent_plan_envelope_replayed' })
        expect(retry.claim()).toBe('agent_plan_envelope_replayed')
    })

    it('lets only one of two concurrently prepared spawns of one envelope launch', () => {
        const { keyPair, consumer } = setup()
        const params = { ...base, agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) } }
        const first = prepareAgentPlanLaunch(params, consumer)
        const second = prepareAgentPlanLaunch(params, consumer)
        if (!first.ok || !second.ok) throw new Error('both prepare')
        expect(first.claim()).toBeNull()
        expect(second.claim()).toBe('agent_plan_envelope_replayed')
    })

    it('refuses to continue a plan thread without a fresh grant (spec §6.3-4)', () => {
        const { consumer } = setup()
        const isPlanThread = (threadId: string) => threadId === 'plan-thread'
        expect(prepareAgentPlanLaunch({ ...base, isPlanThread, resumeCodexThreadId: 'plan-thread' }, consumer))
            .toEqual({ ok: false, reason: 'agent_plan_resume_requires_grant' })
        expect(prepareAgentPlanLaunch({ ...base, isPlanThread, resumeCodexThreadId: 'subscription-thread' }, consumer).ok).toBe(true)
    })

    it('continues a plan thread with a fresh grant', () => {
        const { keyPair, consumer } = setup()
        const result = prepareAgentPlanLaunch({
            ...base, isPlanThread: () => true, resumeCodexThreadId: 'plan-thread',
            agentPlan: { grantEnvelope: seal(plaintext(), keyPair.publicKey) },
        }, consumer)
        expect(result.ok).toBe(true)
    })
})

