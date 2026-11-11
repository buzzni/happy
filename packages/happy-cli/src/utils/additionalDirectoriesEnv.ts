import { isAbsolute } from 'node:path'
import { isUnsafeMandatoryWriteScope } from '@/sandbox/sandboxPolicy'

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

export const APPROVED_WRITE_ROOTS_ENV = 'HAPPY_APPROVED_WRITE_ROOTS'

/**
 * aplus-dev-studio specs/approved-folder-roots R11: folders the machine owner approved are writable in the
 * session sandbox without a per-chat approval, and the credential homes in `denied` stay unwritable.
 * Records exactly what it added, so the next spawn or resume swaps it for the current list and never
 * removes an entry the project policy already had. A filesystem root or the home folder is not granted:
 * writing anywhere there is no sandbox at all, and a mandatory session refuses to start with it.
 */
export function replaceApprovedWriteRootsInEnvironment(
  env: Record<string, string>,
  approved: readonly string[],
  denied: readonly string[],
  homeDir: string,
): void {
  const roots = approved.filter((root) => !isUnsafeMandatoryWriteScope([root], homeDir))
  if (env.HAPPY_PROJECT_SANDBOX_CONFIG === undefined) return
  const config = JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG) as Record<string, unknown>
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid project sandbox config')
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : []
  let previous: { write: string[]; deny: string[] } = { write: [], deny: [] }
  try {
    const parsed = JSON.parse(env[APPROVED_WRITE_ROOTS_ENV] ?? '{}') as Record<string, unknown>
    previous = { write: strings(parsed.write), deny: strings(parsed.deny) }
  } catch { /* An unreadable record withdraws nothing. */ }
  const write = strings(config.extraWritePaths).filter((path) => !previous.write.includes(path))
  const deny = strings(config.denyWritePaths).filter((path) => !previous.deny.includes(path))
  const added = {
    write: roots.filter((path, index) => !write.includes(path) && roots.indexOf(path) === index),
    deny: roots.length ? denied.filter((path, index) => !deny.includes(path) && denied.indexOf(path) === index) : [],
  }
  config.extraWritePaths = [...write, ...added.write]
  config.denyWritePaths = [...deny, ...added.deny]
  env.HAPPY_PROJECT_SANDBOX_CONFIG = JSON.stringify(config)
  if (added.write.length || added.deny.length) env[APPROVED_WRITE_ROOTS_ENV] = JSON.stringify(added)
  else delete env[APPROVED_WRITE_ROOTS_ENV]
}
