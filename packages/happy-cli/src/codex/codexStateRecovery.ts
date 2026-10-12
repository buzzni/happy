import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function codexStateRecoveryRoot(codexHome: string): string {
  return join(codexHome, 'happy-runtime-state')
}

/** Only Happy's verified state recovery changes; the auth home and original databases stay intact. */
export async function resolveCodexStateEnvironment(
  environment: Record<string, string>,
  read: (path: string) => Promise<string> = path => readFile(path, 'utf8'),
): Promise<Record<string, string>> {
  if (environment.CODEX_SQLITE_HOME?.trim()) return environment
  const root = codexStateRecoveryRoot(environment.CODEX_HOME || join(homedir(), '.codex'))
  let content: string
  try { content = await read(join(root, 'current.json')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return environment
    throw error
  }
  const marker = JSON.parse(content) as { version?: unknown; generation?: unknown }
  if (marker?.version !== 1 || typeof marker.generation !== 'number'
    || !Number.isSafeInteger(marker.generation) || marker.generation <= 0) throw new Error('Invalid Codex state recovery marker')
  return { ...environment, CODEX_SQLITE_HOME: join(root, String(marker.generation)) }
}
