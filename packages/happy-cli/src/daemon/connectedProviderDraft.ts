import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import { CODEX_OWNER_MANAGED_REFRESH_TOKEN, readCodexLogin } from '@/codex/codexOwnerManagedLogin'
import { validatePath } from '@/modules/common/pathSecurity'
import { installHappyCommandShim } from '@/utils/happyCommandShim'
import type { ProviderDraftPreparation } from './draftWorkerHost'
import { applyAppliedAiAuthSourceEnv, buildManagedSessionSpawnEnvironment } from './sessionEnv'
import { resolveInheritedSpawnEnvironment } from './spawnAgentCommand'
import { resolveWindowsClaudeWithinBudget } from './windowsClaudeEnvironment'

type Input = { directory: string; allowedRoot: string; approvedRoots(): readonly string[]; ready(): boolean }

function fileLoginDigest(env: NodeJS.ProcessEnv): string | undefined {
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY || env.OPENAI_BASE_URL || env.CODEX_CLI_AUTH_PATH) return
  const contents = readCodexLogin(env)
  if (!contents) return
  try {
    const { auth_mode, tokens } = JSON.parse(contents)
    if ((auth_mode && auth_mode !== 'chatgpt') || typeof tokens?.access_token !== 'string' || !tokens.access_token
      || typeof tokens?.refresh_token !== 'string' || !tokens.refresh_token || tokens.refresh_token === CODEX_OWNER_MANAGED_REFRESH_TOKEN) return
    return createHash('sha256').update(contents).digest('hex')
  } catch { return undefined }
}

function resolveDirectory(input: Input): string | undefined {
  const { directory, allowedRoot, approvedRoots, ready } = input
  if (!ready() || !isAbsolute(directory) || directory.includes('\0')) return
  try {
    const approved = approvedRoots()
    if (!validatePath(directory, allowedRoot, approved).valid) return
    const roots = [allowedRoot, ...approved].flatMap(root => {
      try { return [realpathSync(root)] } catch { return [] }
    })
    const cwd = realpathSync(directory)
    return roots.length && validatePath(cwd, roots[0], roots.slice(1)).valid && statSync(cwd).isDirectory() ? cwd : undefined
  } catch { return undefined }
}

/** The local Desktop owner attests to the connection. This also checks the current daemon profile. */
export function resolveConnectedCodexDraft(input: Input): ProviderDraftPreparation | undefined {
  const cwd = resolveDirectory(input)
  if (!cwd) return
  const env = applyAppliedAiAuthSourceEnv(buildManagedSessionSpawnEnvironment(process.env, {}, {}))
  const digest = fileLoginDigest(env)
  if (!digest) return
  installHappyCommandShim(env)
  return { cwd, env, isCurrent: () => cwd === resolveDirectory(input) && digest === fileLoginDigest(env) }
}

function claudeLoginGeneration(path: string): string | undefined {
  try {
    const storage = statSync(path)
    if (!storage.isFile() || storage.size > 1_048_576) return
    const credential = readFileSync(path, 'utf8')
    const oauth = JSON.parse(credential).claudeAiOauth
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken || typeof oauth.expiresAt !== 'number'
      || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= Date.now() + 60_000) return
    return createHash('sha256').update(credential).digest('hex')
  } catch { return undefined }
}

export async function resolveConnectedClaudeDraft(input: Input): Promise<ProviderDraftPreparation | undefined> {
  const cwd = resolveDirectory(input)
  if (!cwd) return
  const inherited = await resolveInheritedSpawnEnvironment({ agent: 'claude', env: process.env, filterCredentials: false })
  const env = applyAppliedAiAuthSourceEnv(buildManagedSessionSpawnEnvironment(inherited, {}, {}))
  if (!['personal-subscription', 'unknown'].includes(env.HAPPY_AI_AUTH_SOURCE)
    || CLAUDE_AUTH_OVERRIDE_ENV_KEYS.some(key => env[key]) || env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) return
  const override = env.HAPPY_CLAUDE_PATH
  if (override !== undefined && (!override || override !== await resolveWindowsClaudeWithinBudget(env))) return
  const credentialDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  if (!isAbsolute(credentialDir)) return
  const credential = join(credentialDir, '.credentials.json')
  const generation = claudeLoginGeneration(credential)
  if (!generation || !installHappyCommandShim(env)) return
  return { cwd, env, isCurrent: () => cwd === resolveDirectory(input) && generation === claudeLoginGeneration(credential) }
}
