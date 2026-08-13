/**
 * Per-machine/session control over which filesystem settings and skills a
 * remote Claude Agent SDK session loads.
 *
 * By default, the SDK query() wrapper omits `settingSources`/`skills`, so a
 * session loads every source Claude Code would locally — including
 * `~/.claude/settings.json` (which can enable marketplace plugins) and any
 * skill visible to the CLI's own defaults. Operators who run Happy on a
 * managed machine (e.g. Saycode) can set the env vars below to scope a
 * session down to project/local sources and/or an explicit skill allowlist,
 * without touching sessions where these vars are unset.
 */

import type { SettingSource } from '@anthropic-ai/claude-agent-sdk'

const VALID_SETTING_SOURCES: ReadonlySet<string> = new Set(['user', 'project', 'local'])

export interface SkillGovernanceConfig {
    /** Comma-separated subset of 'user' | 'project' | 'local'. Falsy → SDK default (all sources). */
    settingSources?: string | null
    /** 'all', or a comma-separated skill name allowlist. Falsy → SDK default (CLI's own defaults). */
    skillAllowlist?: string | null
}

export interface SkillGovernanceOptions {
    /** Passed straight to QueryOptions.settingSources; undefined leaves the SDK default untouched. */
    settingSources?: SettingSource[]
    /** Passed straight to QueryOptions.skills; undefined leaves the SDK default untouched. */
    skills?: string[] | 'all'
}

/** Reads the per-session skill governance config from a process env-like record (pure). */
export function readSkillGovernanceConfigFromEnv(env: Record<string, string | undefined>): SkillGovernanceConfig {
    return {
        settingSources: env.HAPPY_SETTING_SOURCES,
        skillAllowlist: env.HAPPY_SKILL_ALLOWLIST,
    }
}

function parseSettingSources(value: string | null | undefined): SettingSource[] | undefined {
    if (!value) return undefined
    const valid = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry): entry is SettingSource => VALID_SETTING_SOURCES.has(entry))
    return valid.length > 0 ? valid : undefined
}

function parseSkillAllowlist(value: string | null | undefined): string[] | 'all' | undefined {
    if (!value) return undefined
    if (value.trim() === 'all') return 'all'
    const names = value.split(',').map((entry) => entry.trim()).filter(Boolean)
    return names.length > 0 ? names : undefined
}

/**
 * Builds the SDK `settingSources`/`skills` options for a session. Returns a
 * no-op result ({}) when neither env var is set, so existing sessions are
 * 100% unchanged.
 */
export function buildSkillGovernanceOptions(config: SkillGovernanceConfig): SkillGovernanceOptions {
    const options: SkillGovernanceOptions = {}
    const settingSources = parseSettingSources(config.settingSources)
    if (settingSources) options.settingSources = settingSources
    const skills = parseSkillAllowlist(config.skillAllowlist)
    if (skills) options.skills = skills
    return options
}
