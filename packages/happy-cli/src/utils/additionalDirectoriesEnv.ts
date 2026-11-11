import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { isUnsafeMandatoryWriteScope, resolveSessionSandboxPolicyMode } from '@/sandbox/sandboxPolicy'

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

const strings = (value: unknown) => Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : []

/** The record replaceApprovedWriteRootsInEnvironment leaves behind, or null when it does not parse. */
export function readApprovedWriteRootsEnvironment(raw: string): { write: string[]; deny: string[] } | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    return { write: strings(record.write), deny: strings(record.deny) }
  } catch {
    return null
  }
}

/**
 * aplus-dev-studio specs/approved-folder-roots R11: folders the machine owner approved are writable in the
 * session sandbox without a per-chat approval, and the credential homes in `denied` stay unwritable.
 * Records exactly what it added, so the next spawn or resume swaps it for the current list and never
 * removes an entry the project policy already had.
 */
export function replaceApprovedWriteRootsInEnvironment(
  env: Record<string, string>,
  roots: readonly string[],
  denied: readonly string[],
): void {
  if (env.HAPPY_PROJECT_SANDBOX_CONFIG === undefined) return
  const config = JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG) as Record<string, unknown>
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid project sandbox config')
  // An unreadable record withdraws nothing.
  const previous = readApprovedWriteRootsEnvironment(env[APPROVED_WRITE_ROOTS_ENV] ?? '{}') ?? { write: [], deny: [] }
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
  if (resolveSessionSandboxPolicyMode(env) === 'mandatory') withdrawUnsafeApprovedWriteRoots(env)
}

/**
 * A mandatory sandbox refuses a filesystem or home root as write scope (isUnsafeMandatoryWriteScope), so an
 * approved drive is left out of such a session instead of failing its every start. Call it once the session's
 * policy mode is settled; the record keeps only what stays, so the next swap withdraws exactly that.
 */
export function withdrawUnsafeApprovedWriteRoots(env: Record<string, string>, homeDir: string = homedir()): void {
  const added = env.HAPPY_PROJECT_SANDBOX_CONFIG === undefined || env[APPROVED_WRITE_ROOTS_ENV] === undefined
    ? null
    : readApprovedWriteRootsEnvironment(env[APPROVED_WRITE_ROOTS_ENV])
  const unsafe = added?.write.filter((path) => isUnsafeMandatoryWriteScope([path], homeDir)) ?? []
  if (!added || unsafe.length === 0) return
  const config = JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG!) as Record<string, unknown>
  config.extraWritePaths = strings(config.extraWritePaths).filter((path) => !unsafe.includes(path))
  env.HAPPY_PROJECT_SANDBOX_CONFIG = JSON.stringify(config)
  env[APPROVED_WRITE_ROOTS_ENV] = JSON.stringify({ ...added, write: added.write.filter((path) => !unsafe.includes(path)) })
}
