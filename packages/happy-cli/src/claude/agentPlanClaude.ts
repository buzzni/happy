/** The plan owns routing; only a session-local proxy credential reaches Claude. */
import { AgentPlanLaunchError, type AgentPlanDescriptor } from '@/launcher/agentPlanLaunch'
import { ORG_ENDPOINT_VALUE_ENV_KEYS, ORG_ENDPOINT_CLEARED_ENV_KEYS } from './utils/orgEndpointEnvKeys'
import { ensureLocalProxyBypass } from './utils/proxyBypass'
export function configureClaudePlanEnvironment(env: NodeJS.ProcessEnv, descriptor: AgentPlanDescriptor, baseUrl: string, clientKey: string): void {
    for (const key of ORG_ENDPOINT_CLEARED_ENV_KEYS) env[key] = ''
    const values: Record<typeof ORG_ENDPOINT_VALUE_ENV_KEYS[number], string> = {
        ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: clientKey,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(descriptor.contextWindow),
        ANTHROPIC_MODEL: descriptor.model, ANTHROPIC_DEFAULT_OPUS_MODEL: descriptor.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: descriptor.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: descriptor.model,
        ANTHROPIC_DEFAULT_FABLE_MODEL: descriptor.model, CLAUDE_CODE_SUBAGENT_MODEL: descriptor.model,
        API_TIMEOUT_MS: '1260000', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    }
    Object.assign(env, values)
    // The SDK credential pin promotes this to platform-plan only after it verifies live settings/account.
    env.HAPPY_AI_AUTH_SOURCE = 'platform-plan-pending'
    env.HAPPY_AI_AUTH_CONNECTION_VERSION = ''
    ensureLocalProxyBypass(env)
}

/** A picker cannot be checked against a signed parent grant until it names a transcript. */
export function claudePlanResumeThread(args: string[] | undefined, last: () => string | null, guarded: boolean | (() => boolean)): string | null {
    const values = args ?? []
    for (let i = 0; i < values.length; i++) {
        const arg = values[i]
        const joined = /^(?:--resume=|-r=?)(.+)$/.exec(arg)
        const operand = joined?.[1] ?? (arg === '--resume' || arg === '-r' ? values[i + 1] : undefined)
        if (joined || arg === '--resume' || arg === '-r') {
            if (!operand || operand.startsWith('-') || !/^[A-Za-z0-9_-]{1,128}$/.test(operand)) {
                if (typeof guarded === 'function' ? guarded() : guarded) throw new AgentPlanLaunchError('agent_plan_resume_requires_grant')
                return null
            }
            return operand
        }
    }
    return values.includes('--continue') || values.includes('-c') ? last() : null
}
