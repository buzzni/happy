import { describe, expect, it } from 'vitest'
import {
    AGENT_PLAN_PROVIDER_ID,
    AgentPlanLaunchError,
    agentPlanCodexArgs,
    agentPlanGatewayResponsesUrl,
    agentPlanSessionKeysUrl,
    buildAgentPlanDescriptor,
    readAgentPlanDescriptor,
    serializeAgentPlanDescriptor,
} from './agentPlanLaunch'

const ORIGIN = 'https://saycode.ai'
const GRANT = '3f1c2a4e-1b2c-4d5e-8f90-123456789abc'

function serialized(model = 'gpt-6-luna', origin = ORIGIN): string {
    const descriptor = buildAgentPlanDescriptor({ origin, grantId: GRANT, model })
    if (!descriptor) throw new Error('fixture must build')
    return serializeAgentPlanDescriptor(descriptor)
}

function codeOf(run: () => unknown): string | undefined {
    try {
        run()
    } catch (error) {
        return error instanceof AgentPlanLaunchError ? error.code : `not-a-plan-error: ${String(error)}`
    }
    return undefined
}

describe('buildAgentPlanDescriptor', () => {
    it('accepts Eco only as a canonical Claude Messages descriptor', () => {
        const descriptor = buildAgentPlanDescriptor({ origin: ORIGIN, grantId: GRANT, model: 'deepseek/deepseek-v4.1-flash-eco' })
        expect(descriptor).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash-eco', contextWindow: 200000, autoCompactTokenLimit: 150000 })
        expect(readAgentPlanDescriptor(serializeAgentPlanDescriptor(descriptor!), ORIGIN)).toEqual(descriptor)
    })
    it('fixes the per-model context settings from the grant model (spec §6.3-2)', () => {
        expect(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: GRANT, model: 'gpt-6-luna' })).toMatchObject({
            contextWindow: 1050000, autoCompactTokenLimit: 900000,
        })
        expect(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: GRANT, model: 'gpt-6.1-terra' })).toMatchObject({
            contextWindow: 1050000, autoCompactTokenLimit: 900000,
        })
        expect(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: GRANT, model: 'gpt-6.1-sol' })).toMatchObject({
            contextWindow: 1050000, autoCompactTokenLimit: 900000,
        })
        expect(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: GRANT, model: 'gpt-6-astra' })).toMatchObject({
            contextWindow: 1050000, autoCompactTokenLimit: 900000,
        })
    })

    it('refuses a model outside the plan catalog instead of guessing its context', () => {
        expect(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: GRANT, model: 'gpt-5.1-codex' })).toBeNull()
    })

    it('refuses an origin that is not a bare https (or loopback http) origin', () => {
        expect(buildAgentPlanDescriptor({ origin: 'http://saycode.ai', grantId: GRANT, model: 'gpt-6-luna' })).toBeNull()
        expect(buildAgentPlanDescriptor({ origin: 'https://saycode.ai/api', grantId: GRANT, model: 'gpt-6-luna' })).toBeNull()
        expect(buildAgentPlanDescriptor({ origin: 'http://127.0.0.1:5173', grantId: GRANT, model: 'gpt-6-luna' })).not.toBeNull()
    })

    it('refuses a grant id with characters a server id never has', () => {
        expect(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: 'a/b', model: 'gpt-6-luna' })).toBeNull()
        expect(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: '', model: 'gpt-6-luna' })).toBeNull()
    })
})

describe('readAgentPlanDescriptor (canonical shape)', () => {
    it('accepts exactly what the daemon serialized for the trusted origin', () => {
        const descriptor = readAgentPlanDescriptor(serialized(), ORIGIN)
        expect(descriptor).toEqual({
            version: 1, origin: ORIGIN, grantId: GRANT, model: 'gpt-6-luna', contextWindow: 1050000, autoCompactTokenLimit: 900000,
        })
    })

    it.each([
        ['gpt-6-luna', 128000, 100000], ['gpt-6.1-terra', 128000, 100000],
        ['gpt-6.1-sol', 64000, 48000], ['gpt-6-astra', 64000, 48000],
    ])('upgrades the saved legacy descriptor for %s without changing its grant', (model, contextWindow, autoCompactTokenLimit) => {
        const legacy = JSON.stringify({ version: 1, origin: ORIGIN, grantId: GRANT, model, contextWindow, autoCompactTokenLimit })
        expect(readAgentPlanDescriptor(legacy, ORIGIN)).toEqual(buildAgentPlanDescriptor({ origin: ORIGIN, grantId: GRANT, model }))
        expect(readAgentPlanDescriptor(legacy, ORIGIN).contextWindow).toBe(1050000)
    })

    it('refuses a descriptor whose context settings were raised by hand', () => {
        const tampered = serialized().replace('"contextWindow":1050000', '"contextWindow":400000')
        expect(codeOf(() => readAgentPlanDescriptor(tampered, ORIGIN))).toBe('agent_plan_descriptor_invalid')
    })

    it('refuses a descriptor carrying a key the daemon never writes', () => {
        const extended = serialized().replace(/}$/, ',"baseUrl":"https://elsewhere.example"}')
        expect(codeOf(() => readAgentPlanDescriptor(extended, ORIGIN))).toBe('agent_plan_descriptor_invalid')
    })

    it('refuses a descriptor that would send the grant secret to another origin than the trusted one', () => {
        expect(codeOf(() => readAgentPlanDescriptor(serialized('gpt-6-luna', 'https://evil.example'), ORIGIN)))
            .toBe('agent_plan_descriptor_invalid')
    })

    it('refuses when the runner has no trusted Studio origin at all', () => {
        expect(codeOf(() => readAgentPlanDescriptor(serialized(), null))).toBe('agent_plan_descriptor_invalid')
    })

    it('refuses unreadable JSON', () => {
        expect(codeOf(() => readAgentPlanDescriptor('{not json', ORIGIN))).toBe('agent_plan_descriptor_invalid')
    })
})

describe('agentPlanCodexArgs', () => {
    it('pins the plan provider, the grant model and its context, with web search off', () => {
        const descriptor = readAgentPlanDescriptor(serialized('gpt-6.1-sol'), ORIGIN)
        expect(agentPlanCodexArgs(descriptor, 'http://127.0.0.1:43210/v1')).toEqual([
            '-c', `model_provider="${AGENT_PLAN_PROVIDER_ID}"`,
            '-c', `model_providers.${AGENT_PLAN_PROVIDER_ID}.name="Saycode plan"`,
            '-c', `model_providers.${AGENT_PLAN_PROVIDER_ID}.base_url="http://127.0.0.1:43210/v1"`,
            '-c', `model_providers.${AGENT_PLAN_PROVIDER_ID}.wire_api="responses"`,
            '-c', `model_providers.${AGENT_PLAN_PROVIDER_ID}.requires_openai_auth=false`,
            '-c', `model_providers.${AGENT_PLAN_PROVIDER_ID}.env_key="HAPPY_AGENT_PLAN_PROXY_KEY"`,
            '-c', 'model="gpt-6.1-sol"',
            '-c', 'model_context_window=1050000',
            '-c', 'model_auto_compact_token_limit=900000',
            '-c', 'disable_response_storage=true',
            '-c', 'web_search="disabled"',
        ])
    })
})

describe('Studio endpoints', () => {
    it('derives the key exchange and gateway URLs from the descriptor origin only', () => {
        const descriptor = readAgentPlanDescriptor(serialized(), ORIGIN)
        expect(agentPlanSessionKeysUrl(descriptor)).toBe('https://saycode.ai/api/agent-plan/session-keys')
        expect(agentPlanGatewayResponsesUrl(descriptor)).toBe('https://saycode.ai/api/agent-plan/v1/responses')
    })
})
