import { describe, expect, it } from 'vitest'
import {
  resolveInheritedSpawnEnvironment,
  resolveRegularSpawnAgentArgs,
  resolveAgentAuthEnvironment,
  resolveTmuxSpawnAgentCommand,
  shouldFilterSpawnCredentials,
} from './spawnAgentCommand'

describe('spawnAgentCommand', () => {
  it('routes opencode through the ACP subcommand for regular process spawn', () => {
    expect(resolveRegularSpawnAgentArgs('opencode')).toEqual(['acp', 'opencode'])
  })

  it('routes opencode through the ACP subcommand for tmux spawn', () => {
    expect(resolveTmuxSpawnAgentCommand('opencode')).toBe('acp opencode')
  })

  it('spawns grok through its own first-class subcommand', () => {
    expect(resolveRegularSpawnAgentArgs('grok')).toEqual(['grok'])
    expect(resolveTmuxSpawnAgentCommand('grok')).toBe('grok')
  })

  it('carries the xAI api key when grok runs read-only', () => {
    expect(resolveReadOnlyAgentAuthEnvironment('grok', { XAI_API_KEY: 'xai', OPENAI_API_KEY: 'codex' }))
      .toEqual({ XAI_API_KEY: 'xai' })
  })

  it('keeps existing agents on their direct commands', () => {
    expect(resolveRegularSpawnAgentArgs('claude')).toEqual(['claude'])
    expect(resolveRegularSpawnAgentArgs('codex')).toEqual(['codex'])
    expect(resolveRegularSpawnAgentArgs('gemini')).toEqual(['gemini'])
    expect(resolveRegularSpawnAgentArgs('openclaw')).toEqual(['openclaw'])

    expect(resolveTmuxSpawnAgentCommand('claude')).toBe('claude')
    expect(resolveTmuxSpawnAgentCommand('codex')).toBe('codex')
    expect(resolveTmuxSpawnAgentCommand('gemini')).toBe('gemini')
    expect(resolveTmuxSpawnAgentCommand('openclaw')).toBe('openclaw')
  })

  it.each([
    [{ sandboxEnabled: true }, true],
    [{ sandboxEnabled: false, permissionMode: 'read-only' as const }, true],
    [{ sandboxEnabled: false, isolatedAutomation: true }, true],
    [{ sandboxEnabled: false }, false],
  ])('filters inherited credentials when spawn isolation requires it', (input, expected) => {
    expect(shouldFilterSpawnCredentials(input)).toBe(expected)
  })

  it.each([
    ['claude' as const, { ANTHROPIC_API_KEY: 'claude', OPENAI_API_KEY: 'codex' }, { ANTHROPIC_API_KEY: 'claude' }],
    ['codex' as const, { OPENAI_API_KEY: 'codex', GH_TOKEN: 'github' }, { OPENAI_API_KEY: 'codex' }],
    ['gemini' as const, { GEMINI_API_KEY: 'gemini', AWS_ACCESS_KEY_ID: 'aws' }, { GEMINI_API_KEY: 'gemini' }],
  ])('retains only the selected agent authentication', (agent, env, expected) => {
    expect(resolveAgentAuthEnvironment(agent, env)).toEqual(expected)
  })

  it('filters daemon credentials while restoring only the selected agent authentication', () => {
    expect(resolveInheritedSpawnEnvironment({
      agent: 'claude',
      filterCredentials: true,
      env: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'claude-auth',
        OPENAI_API_KEY: 'other-agent-auth',
        GH_TOKEN: 'unscoped-github-token',
        DATABASE_URL: 'production-database',
      },
    })).toEqual({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'claude-auth',
    })
  })
})
