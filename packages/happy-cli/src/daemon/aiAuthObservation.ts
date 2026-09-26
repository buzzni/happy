/**
 * The observed AI auth source of a spawn: what credential the machine was set
 * up to use when this session started, and whether anything could divert it.
 *
 * This is observation, not proof. `org-bundle` here means: at spawn time the
 * machine's Claude login was one of the accounts a company deployed through the
 * platform, and none of the known ways to route the session around that login
 * was present. It does **not** bind each request to that credential — that
 * needs execution isolation (specs/agent-ai-source-routing, P3).
 *
 * It is reported on its own channel (`HAPPY_AI_AUTH_OBSERVED_SOURCE`) and never
 * through `HAPPY_AI_AUTH_SOURCE`: an explicit credential selection is verified
 * against the latter, and an observation must not approve a selection.
 *
 * Every piece of evidence has to be present and readable. Anything missing,
 * unreadable or unexpected is `unknown` — and this function never throws, so a
 * failure here can never cost the session its usage report.
 */
import { join } from 'node:path'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import { readActiveClaudeProvenance } from './aiCredentialProvenance'

export type ObservedAiAuthSource = 'org-bundle' | 'unknown'

/** Where Claude Code looks for machine-wide policy settings, per platform. */
export const CLAUDE_MANAGED_SETTINGS_PATHS = [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/etc/claude-code/managed-settings.json',
    'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
]

type ReadFile = (path: string) => Promise<string>

/** Parsed JSON, `null` for a file that does not exist; throws for anything else. */
async function readOptionalJson(readFile: ReadFile, path: string): Promise<unknown> {
    let raw: string
    try {
        raw = await readFile(path)
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw error
    }
    return JSON.parse(raw) as unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOverrideKey(values: Record<string, unknown>): boolean {
    return CLAUDE_AUTH_OVERRIDE_ENV_KEYS.some((key) => values[key] !== undefined)
}

/** A settings file's `env` beats the environment the spawn produced. */
function settingsDivert(settings: unknown): boolean {
    if (settings === null) return false
    if (!isObject(settings)) return true
    if (settings.apiKeyHelper !== undefined) return true
    return isObject(settings.env) && hasOverrideKey(settings.env)
}

/**
 * The login identity Claude Code will read, resolved the way Claude Code (and
 * cswap, which mirrors it) resolves it: the legacy `<config home>/.config.json`
 * when it exists, otherwise `(CLAUDE_CONFIG_DIR || $HOME)/.claude.json`.
 */
async function liveIdentity(
    readFile: ReadFile,
    homeDir: string,
    configDir: string | undefined,
): Promise<string | null> {
    const configHome = configDir ?? join(homeDir, '.claude')
    const legacy = await readOptionalJson(readFile, join(configHome, '.config.json'))
    const config = legacy ?? await readOptionalJson(readFile, join(configDir ?? homeDir, '.claude.json'))
    if (!isObject(config) || !isObject(config.oauthAccount)) return null
    const { emailAddress, organizationUuid } = config.oauthAccount
    if (typeof emailAddress !== 'string' || emailAddress === '') return null
    if (organizationUuid !== undefined && typeof organizationUuid !== 'string') return null
    return JSON.stringify([emailAddress, organizationUuid ?? ''])
}

export async function observeClaudeAiAuthSource(input: {
    agent: string
    spawnPath: 'spawn' | 'resume' | 'tmux'
    /** The final environment the child will run with. */
    env: Record<string, string | undefined>
    /** The child's working directory — where project settings are read from. */
    cwd: string | undefined
    homeDir: string
    readFile: ReadFile
    managedSettingsPaths?: readonly string[]
}): Promise<ObservedAiAuthSource> {
    try {
        if (input.agent !== 'claude') return 'unknown'
        // tmux applies only the keys it is handed; whatever an earlier session
        // left on the tmux server is invisible here.
        if (input.spawnPath === 'tmux') return 'unknown'
        if (!input.cwd) return 'unknown'
        if (hasOverrideKey(input.env)) return 'unknown'

        // Cheapest discriminator first: most machines have no company deployment
        // and stop here after one missing file.
        const provenance = await readActiveClaudeProvenance({
            homeDir: input.homeDir,
            readFile: input.readFile,
        })
        if (!provenance) return 'unknown'

        const configDir = input.env.CLAUDE_CONFIG_DIR || undefined
        const settingsPaths = [
            join(configDir ?? join(input.homeDir, '.claude'), 'settings.json'),
            join(input.cwd, '.claude', 'settings.json'),
            join(input.cwd, '.claude', 'settings.local.json'),
            ...(input.managedSettingsPaths ?? CLAUDE_MANAGED_SETTINGS_PATHS),
        ]
        for (const path of settingsPaths) {
            if (settingsDivert(await readOptionalJson(input.readFile, path))) return 'unknown'
        }

        const identity = await liveIdentity(input.readFile, input.homeDir, configDir)
        if (!identity || !provenance.identities.has(identity)) return 'unknown'

        return 'org-bundle'
    } catch {
        return 'unknown'
    }
}
