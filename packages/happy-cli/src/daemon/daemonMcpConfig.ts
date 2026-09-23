import { readSettings, updateSettings } from '@/persistence'

const CONFIG_URL_ENV_KEY = 'HAPPY_APLUS_MCP_CONFIG_URL'

type ResolveDaemonMcpConfigOptions = {
  persistExplicit?: boolean
}

function assertValidConfigUrl(value: string, source: 'explicit' | 'persisted'): void {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('unsupported URL')
    }
  } catch {
    const label = source === 'persisted'
      ? 'persisted Aplus MCP config URL'
      : CONFIG_URL_ENV_KEY
    throw new Error(`Invalid ${label}`)
  }
}

export async function resolveDaemonMcpConfigEnvironment(
  environment: NodeJS.ProcessEnv,
  options: ResolveDaemonMcpConfigOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const explicitUrl = environment[CONFIG_URL_ENV_KEY]
  if (explicitUrl !== undefined) {
    assertValidConfigUrl(explicitUrl, 'explicit')
    if (options.persistExplicit) {
      await updateSettings(settings => ({ ...settings, aplusMcpConfigUrl: explicitUrl }))
    }
    return environment
  }

  const persistedUrl = (await readSettings()).aplusMcpConfigUrl
  if (persistedUrl === undefined) {
    return environment
  }

  assertValidConfigUrl(persistedUrl, 'persisted')
  return { ...environment, [CONFIG_URL_ENV_KEY]: persistedUrl }
}
