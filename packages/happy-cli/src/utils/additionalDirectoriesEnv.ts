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

/**
 * Swaps the roots a session was granted for `next` — used when a session is
 * resumed, so roots registered (or removed) while it was stopped take effect.
 * Only roots recorded in HAPPY_ADDITIONAL_DIRECTORIES are withdrawn; a session
 * spawned before that record existed keeps its merged roots, because they are
 * indistinguishable from project policy.
 */
export function replaceAdditionalDirectoriesInEnvironment(
  env: Record<string, string>,
  next: readonly string[],
): void {
  const previous = env[ADDITIONAL_DIRECTORIES_ENV] === undefined
    ? []
    : readAdditionalDirectoriesEnvironment(env)
  if (previous.length > 0 && env.HAPPY_PROJECT_SANDBOX_CONFIG !== undefined) {
    const config = JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG) as Record<string, unknown>
    if (Array.isArray(config.extraWritePaths)) {
      const withdrawn = new Set(previous)
      config.extraWritePaths = config.extraWritePaths.filter((path) => !withdrawn.has(path as string))
      env.HAPPY_PROJECT_SANDBOX_CONFIG = JSON.stringify(config)
    }
  }
  if (next.length === 0) {
    delete env[ADDITIONAL_DIRECTORIES_ENV]
    return
  }
  env[ADDITIONAL_DIRECTORIES_ENV] = JSON.stringify(next)
  mergeAdditionalDirectoriesIntoSandboxEnvironment(env, next)
}
