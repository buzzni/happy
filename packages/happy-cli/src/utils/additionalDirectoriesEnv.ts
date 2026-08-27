import { isAbsolute } from 'node:path'

export const ADDITIONAL_DIRECTORIES_ENV = 'HAPPY_ADDITIONAL_DIRECTORIES'

export function readAdditionalDirectoriesEnvironment(env: NodeJS.ProcessEnv): string[] {
  const raw = env[ADDITIONAL_DIRECTORIES_ENV]
  if (raw === undefined) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (
      !Array.isArray(value)
      || value.length > 8
      || value.some((directory) => typeof directory !== 'string' || !isAbsolute(directory))
    ) {
      throw new Error('invalid value')
    }
    return [...value]
  } catch {
    throw new Error('Invalid additional directories environment')
  }
}

export function mergeAdditionalDirectoriesIntoSandboxEnvironment(
  env: Record<string, string>,
  directories: readonly string[],
): void {
  if (directories.length === 0 || env.HAPPY_PROJECT_SANDBOX_CONFIG === undefined) return
  const parsed = JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid project sandbox config')
  }
  const config = parsed as Record<string, unknown>
  const existing = Array.isArray(config.extraWritePaths)
    ? config.extraWritePaths.filter((path): path is string => typeof path === 'string')
    : []
  config.extraWritePaths = [...new Set([...existing, ...directories])]
  env.HAPPY_PROJECT_SANDBOX_CONFIG = JSON.stringify(config)
}
