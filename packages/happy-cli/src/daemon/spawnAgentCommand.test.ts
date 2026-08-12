import { describe, expect, it } from 'vitest'
import {
  resolveRegularSpawnAgentArgs,
  resolveReadOnlyAgentAuthEnvironment,
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
    [{ sandboxEnabled: false }, false],
  ])('filters inherited credentials when spawn isolation requires it', (input, expected) => {
    expect(shouldFilterSpawnCredentials(input)).toBe(expected)
  })

  it.each([
    ['claude' as const, { ANTHROPIC_API_KEY: 'claude', OPENAI_API_KEY: 'codex' }, { ANTHROPIC_API_KEY: 'claude' }],
    ['codex' as const, { OPENAI_API_KEY: 'codex', GH_TOKEN: 'github' }, { OPENAI_API_KEY: 'codex' }],
    ['gemini' as const, { GEMINI_API_KEY: 'gemini', AWS_ACCESS_KEY_ID: 'aws' }, { GEMINI_API_KEY: 'gemini' }],
  ])('retains only the selected read-only agent authentication', (agent, env, expected) => {
    expect(resolveReadOnlyAgentAuthEnvironment(agent, env)).toEqual(expected)
  })
})
