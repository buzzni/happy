import { readSettings, updateSettings } from '@/persistence'

const CONFIG_URL_ENV_KEY = 'HAPPY_APLUS_MCP_CONFIG_URL'

type ResolveDaemonMcpConfigOptions = {
  persistExplicit?: boolean
}

function normalizeConfigEndpoint(value: unknown, source: 'explicit' | 'persisted'): string {
  try {
    if (typeof value !== 'string') throw new Error('URL must be a string')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('unsupported URL')
    }
    // A session can restart the daemon with a project-scoped URL from
    // injectMcpCallerGrant. Persist only the endpoint, never session query
    // parameters or fragments (which can also contain credentials).
    url.search = ''
    url.hash = ''
    return url.toString()
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
    const endpoint = normalizeConfigEndpoint(explicitUrl, 'explicit')
    if (options.persistExplicit) {
      await updateSettings(settings => ({ ...settings, aplusMcpConfigUrl: endpoint }))
    }
    return { ...environment, [CONFIG_URL_ENV_KEY]: endpoint }
  }

  const persistedUrl = (await readSettings()).aplusMcpConfigUrl
  if (persistedUrl === undefined) {
    return environment
  }

  return { ...environment, [CONFIG_URL_ENV_KEY]: normalizeConfigEndpoint(persistedUrl, 'persisted') }
}
