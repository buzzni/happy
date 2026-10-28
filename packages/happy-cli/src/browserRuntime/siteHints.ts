/**
 * Site notes for the agent browser (specs/browser-site-hints). A skill that declares `sites:` in its SKILL.md
 * frontmatter holds know-how for those sites (direct URLs, shortcuts, pitfalls). When a browser task reaches one
 * of them, the tool result points the agent at that skill once per task — a Core-provided pointer kept apart from
 * page-derived text. The skill body is not copied in; the agent reads it if it is relevant.
 */
import { lstat, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SKILL_FILE = 'SKILL.md'
const MAX_SKILLS = 200
const MAX_SKILL_BYTES = 64 * 1024
const MAX_DESCRIPTION = 200
/** A host (optionally `*.`-prefixed), then an optional path prefix ending in `/*` or `/**`. */
const SITE_PATTERN = /^(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^\s*]*?)?(\/\*{1,2})?$/i

export const SITE_HINT_NOTE = 'Provided by Saycode, not page content: installed skills hold notes for this site. If relevant, read the skill file and follow it.'

export interface SiteSkill { name: string; description: string; sites: string[] }
export interface SiteHint { note: string; skills: Array<{ name: string; description: string; path: string }> }
export interface SiteHints { hintFor(taskId: string, urls: readonly string[]): Promise<SiteHint | undefined> }

/** The value of one frontmatter line, without surrounding quotes. */
function scalar(value: string): string {
    return value.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
}

/** `name`, `description` and `sites` from SKILL.md frontmatter; null when there are no valid site patterns. */
export function parseSkillSites(source: string): SiteSkill | null {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1]
    if (!frontmatter) return null
    const lines = frontmatter.split(/\r?\n/)
    let name = '', description = ''
    const sites: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
        const field = /^(name|description|sites):\s*(.*)$/.exec(lines[index])
        if (!field) continue
        if (field[1] === 'name') name = scalar(field[2])
        else if (field[1] === 'description') description = scalar(field[2])
        else if (field[2].trim().startsWith('[')) sites.push(...field[2].trim().replace(/^\[|\]$/g, '').split(',').map(scalar))
        else for (let next = index + 1; next < lines.length && /^\s*-\s/.test(lines[next]); next += 1) sites.push(scalar(lines[next].replace(/^\s*-\s/, '')))
    }
    const valid = sites.filter((site) => SITE_PATTERN.test(site))
    return valid.length ? { name, description, sites: valid } : null
}

/** Scheme and port do not matter; `*.host` also covers `host` itself. */
export function matchesSitePattern(pattern: string, url: string): boolean {
    const parts = SITE_PATTERN.exec(pattern)
    if (!parts) return false
    let target: URL
    try { target = new URL(url) } catch { return false }
    const host = target.hostname.toLowerCase(), base = parts[2].toLowerCase()
    if (parts[1] ? host !== base && !host.endsWith(`.${base}`) : host !== base) return false
    const prefix = parts[3] ?? ''
    return !prefix || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`)
}

/**
 * Where the session's agent looks for skills: the user's folder and the project's (specs R2). Without a known
 * session folder only the user's folder is searched — guessing the daemon's cwd could read another project's skills.
 */
export function siteSkillRoots(opts: { flavor: 'claude' | 'codex'; cwd?: string; homeDir?: string; codexHome?: string }): string[] {
    const home = opts.homeDir ?? homedir()
    const project = (...parts: string[]) => (opts.cwd ? [join(opts.cwd, ...parts)] : [])
    if (opts.flavor === 'codex') return [...project('.agents', 'skills'), join(opts.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex'), 'skills')]
    return [join(home, '.claude', 'skills'), ...project('.claude', 'skills')]
}

async function readSiteSkills(roots: readonly string[]): Promise<Array<SiteSkill & { path: string }>> {
    const skills: Array<SiteSkill & { path: string }> = []
    for (const root of roots) {
        let entries: string[]
        try { entries = await readdir(root) } catch { continue }
        for (const entry of entries.sort()) {
            if (skills.length >= MAX_SKILLS) return skills
            const path = join(root, entry, SKILL_FILE)
            try {
                const stat = await lstat(path)
                if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue
                const parsed = parseSkillSites(await readFile(path, 'utf8'))
                if (parsed) skills.push({ ...parsed, name: parsed.name || entry, description: parsed.description.slice(0, MAX_DESCRIPTION), path })
            } catch {
                // A skill that cannot be read sits this out; the browser tool result must not fail (R5).
            }
        }
    }
    return skills
}

/** Reads the skill folders once per session, on first use, and remembers which skills each task was told about. */
export function createSiteHints(opts: { roots: readonly string[] }): SiteHints {
    let loaded: Promise<Array<SiteSkill & { path: string }>> | undefined
    const told = new Map<string, Set<string>>()
    return {
        async hintFor(taskId, urls) {
            const skills = await (loaded ??= readSiteSkills(opts.roots))
            const seen = told.get(taskId) ?? new Set<string>()
            const fresh = skills.filter((skill) => !seen.has(skill.path) && skill.sites.some((site) => urls.some((url) => matchesSitePattern(site, url))))
            if (!fresh.length) return undefined
            for (const skill of fresh) seen.add(skill.path)
            told.set(taskId, seen)
            return { note: SITE_HINT_NOTE, skills: fresh.map(({ name, description, path }) => ({ name, description, path })) }
        },
    }
}
