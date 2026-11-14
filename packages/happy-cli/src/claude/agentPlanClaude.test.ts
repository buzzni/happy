import { describe, it, expect } from 'vitest'
import { buildAgentPlanDescriptor } from '@/launcher/agentPlanLaunch'
import { configureClaudePlanEnvironment, claudePlanResumeThread } from './agentPlanClaude'
import { foldModelToOrgEndpoint } from './utils/orgEndpointModel'
import { orgEndpointRoutingSettingsEnv } from './utils/orgEndpointEnvKeys'
import { orgEndpointLocalModeRefusal } from './utils/orgEndpointLocalMode'

describe('Claude plan routing', () => {
    it('pins every model alias and closes inherited credentials and terminal mode', () => {
        const descriptor = buildAgentPlanDescriptor({ origin: 'https://saycode.ai', grantId: 'grant-1', model: 'deepseek/deepseek-v4.1-flash-eco' })!
        const env = { CLAUDE_CODE_OAUTH_TOKEN: 'personal', ANTHROPIC_API_KEY: 'personal-key' } as NodeJS.ProcessEnv
        configureClaudePlanEnvironment(env, descriptor, 'http://127.0.0.1:12345', 'proxy-only-key')
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
        expect(env.ANTHROPIC_API_KEY).toBe('')
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-only-key')
        expect(Number(env.API_TIMEOUT_MS)).toBeGreaterThan(2 * 600000)
        expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe(descriptor.model)
        expect(foldModelToOrgEndpoint('claude-opus-5-5', env)).toBe(descriptor.model)
        expect(orgEndpointRoutingSettingsEnv(env)?.ANTHROPIC_MODEL).toBe(descriptor.model)
        expect(orgEndpointRoutingSettingsEnv(env)).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
        expect(orgEndpointLocalModeRefusal(env)).toBeTruthy()
    })
})

describe('Claude resume arguments', () => {
    it('resolves named and last-conversation resumes without allowing an unverifiable picker', () => {
        expect(claudePlanResumeThread(['--resume', 'thread-1'], () => null, true)).toBe('thread-1')
        expect(claudePlanResumeThread(['--continue'], () => 'thread-2', true)).toBe('thread-2')
        expect(() => claudePlanResumeThread(['--resume'], () => null, true)).toThrow('agent_plan_resume_requires_grant')
        expect(claudePlanResumeThread([], () => null, true)).toBeNull()
    })
})

it('evaluates marker-directory guarding only for an unverifiable resume picker', () => {
    let calls = 0
    const guard = () => { calls++; return false }
    expect(claudePlanResumeThread([], () => null, guard)).toBeNull()
    expect(claudePlanResumeThread(['--resume', 'named'], () => null, guard)).toBe('named')
    expect(calls).toBe(0)
    expect(claudePlanResumeThread(['--resume'], () => null, guard)).toBeNull()
    expect(calls).toBe(1)
})
