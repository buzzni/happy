import { readSettings, updateSettings } from '@/persistence'
import { readTrustedStudioOrigin } from './setupTokenBindingProof'

const ORIGIN_ENV_KEY = 'HAPPY_APLUS_STUDIO_ORIGIN'
const OFFICIAL_STUDIO_ORIGIN = 'https://saycode.ai'

/** Resolve local trust before daemon startup; neither server responses nor MCP URLs establish trust. */
export async function resolveDaemonStudioOriginEnvironment(
  environment: NodeJS.ProcessEnv,
  serverUrl: string,
): Promise<NodeJS.ProcessEnv> {
  const settings = await readSettings({ strict: true })
  const explicit = environment[ORIGIN_ENV_KEY] !== undefined
  function resolveOrigin(storedOrigin: unknown): string | null {
    const raw = explicit ? environment[ORIGIN_ENV_KEY] : storedOrigin
    if (raw !== undefined) {
      const origin = typeof raw === 'string' ? readTrustedStudioOrigin({ [ORIGIN_ENV_KEY]: raw }) : null
      if (!origin) throw new Error(`Invalid ${explicit ? ORIGIN_ENV_KEY : 'persisted Studio origin'}`)
      return origin
    }
    // Only the built-in official cloud is eligible for legacy/default recovery.
    // A custom relay (including development) needs an explicitly configured Studio origin.
    return readTrustedStudioOrigin({ [ORIGIN_ENV_KEY]: serverUrl }) === OFFICIAL_STUDIO_ORIGIN
      ? OFFICIAL_STUDIO_ORIGIN : null
  }
  let origin = resolveOrigin(settings.aplusStudioOrigin)
  if (!origin) return environment
  if (settings.aplusStudioOrigin !== origin) {
    // Re-read trust while holding the settings lock so a concurrent registration wins over a default.
    await updateSettings(current => {
      origin = resolveOrigin(current.aplusStudioOrigin)
      return { ...current, aplusStudioOrigin: origin ?? undefined }
    }, { strict: true })
  }
  return origin ? { ...environment, [ORIGIN_ENV_KEY]: origin } : environment
}
