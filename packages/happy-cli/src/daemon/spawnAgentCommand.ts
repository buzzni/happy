import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers'
import { filterCredentialsFromEnv } from '@/sandbox/config'

type SpawnAgent = SpawnSessionOptions['agent']

export function shouldFilterSpawnCredentials(input: {
  sandboxEnabled: boolean
  permissionMode?: SpawnSessionOptions['permissionMode']
  isolatedAutomation?: boolean
}): boolean {
  return input.sandboxEnabled || input.permissionMode === 'read-only' || input.isolatedAutomation === true
}

export function resolveAgentAuthEnvironment(
  agent: SpawnAgent,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const keys = (() => {
    switch (agent) {
      case undefined:
      case 'claude':
        return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
      case 'codex':
        return ['OPENAI_API_KEY']
      case 'gemini':
        return ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
      case 'grok':
        return ['XAI_API_KEY']
      case 'openclaw':
      case 'opencode':
        return []
    }
  })()
  return Object.fromEntries(
    keys.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
  ) as Record<string, string>
}

export function resolveInheritedSpawnEnvironment(input: {
  agent: SpawnAgent
  env: NodeJS.ProcessEnv
  filterCredentials: boolean
}): Record<string, string> {
  if (!input.filterCredentials) {
    return Object.fromEntries(
      Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
  }
  return {
    ...filterCredentialsFromEnv(input.env),
    ...resolveAgentAuthEnvironment(input.agent, input.env),
  }
}

export function resolveTmuxSpawnAgentCommand(agent: SpawnAgent): string | undefined {
  switch (agent) {
    case undefined:
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'gemini':
      return 'gemini'
    case 'grok':
      return 'grok'
    case 'openclaw':
      return 'openclaw'
    case 'opencode':
      return 'acp opencode'
  }
}

export function resolveRegularSpawnAgentArgs(agent: SpawnAgent): string[] | undefined {
  switch (agent) {
    case undefined:
    case 'claude':
      return ['claude']
    case 'codex':
      return ['codex']
    case 'gemini':
      return ['gemini']
    case 'grok':
      return ['grok']
    case 'openclaw':
      return ['openclaw']
    case 'opencode':
      return ['acp', 'opencode']
  }
}
