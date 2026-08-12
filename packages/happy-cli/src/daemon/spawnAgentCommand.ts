import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers'

type SpawnAgent = SpawnSessionOptions['agent']

export function shouldFilterSpawnCredentials(input: {
  sandboxEnabled: boolean
  permissionMode?: SpawnSessionOptions['permissionMode']
}): boolean {
  return input.sandboxEnabled || input.permissionMode === 'read-only'
}

export function resolveReadOnlyAgentAuthEnvironment(
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
      case 'openclaw':
      case 'opencode':
        return []
    }
  })()
  return Object.fromEntries(
    keys.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
  ) as Record<string, string>
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
    case 'openclaw':
      return ['openclaw']
    case 'opencode':
      return ['acp', 'opencode']
  }
}
