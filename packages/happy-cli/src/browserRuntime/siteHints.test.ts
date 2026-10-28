/** Site notes: skills that declare `sites:` are pointed out once per task when the agent browser reaches them. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSiteHints, matchesSitePattern, parseSkillSites, siteSkillRoots } from './siteHints'

const dirs: string[] = []
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-site-hints-'))
    dirs.push(dir)
    return dir
}
async function skill(root: string, name: string, frontmatter: string, body = 'Notes.'): Promise<string> {
    await mkdir(join(root, name), { recursive: true })
    const path = join(root, name, 'SKILL.md')
    await writeFile(path, `---\n${frontmatter}\n---\n\n${body}\n`)
    return path
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('parseSkillSites (R1)', () => {
    it('reads name, description and a block or inline sites list', () => {
        expect(parseSkillSites('---\nname: github\ndescription: "GitHub shortcuts"\nsites:\n  - github.com\n  - gist.github.com\n---\nbody'))
            .toEqual({ name: 'github', description: 'GitHub shortcuts', sites: ['github.com', 'gist.github.com'] })
        expect(parseSkillSites("---\nname: wiki\ndescription: Confluence\nsites: [ '*.atlassian.net/wiki/**', notion.so ]\n---\n"))
            .toEqual({ name: 'wiki', description: 'Confluence', sites: ['*.atlassian.net/wiki/**', 'notion.so'] })
    })

    it('ignores skills without sites, without frontmatter, or with only invalid patterns', () => {
        expect(parseSkillSites('---\nname: plain\ndescription: x\n---\n')).toBeNull()
        expect(parseSkillSites('# no frontmatter\nsites: [a.com]')).toBeNull()
        expect(parseSkillSites('---\nname: bad\nsites: ["http://a.com", "a b", ""]\n---\n')).toBeNull()
    })
})

describe('matchesSitePattern (R1)', () => {
    it.each([
        ['github.com', 'https://github.com/buzzni/happy/pull/1', true],
        ['github.com', 'https://gist.github.com/x', false],
        ['*.github.com', 'https://gist.github.com/x', true],
        ['*.github.com', 'https://github.com/x', true],
        ['*.atlassian.net/wiki/**', 'https://acme.atlassian.net/wiki/spaces/X', true],
        ['*.atlassian.net/wiki/**', 'https://acme.atlassian.net/jira/browse/X', false],
        ['calendar.google.com/*', 'https://calendar.google.com/calendar/r', true],
        ['github.com', 'not a url', false],
        ['github.com', 'https://GitHub.com:443/', true],
    ])('%s ~ %s → %s', (pattern, url, expected) => {
        expect(matchesSitePattern(pattern, url)).toBe(expected)
    })
})

describe('siteSkillRoots (R2)', () => {
    it('looks in the user and project skill folders of the session agent', () => {
        expect(siteSkillRoots({ flavor: 'claude', cwd: '/repo', homeDir: '/home/u' })).toEqual(['/home/u/.claude/skills', '/repo/.claude/skills'])
        expect(siteSkillRoots({ flavor: 'codex', cwd: '/repo', homeDir: '/home/u', codexHome: '/opt/codex' })).toEqual(['/repo/.agents/skills', '/opt/codex/skills'])
    })

    it("searches only the user's folder when the session folder is unknown", () => {
        expect(siteSkillRoots({ flavor: 'claude', homeDir: '/home/u' })).toEqual(['/home/u/.claude/skills'])
    })
})

describe('createSiteHints (R2–R5)', () => {
    it('points out each matching skill once per task, with name, description and path only', async () => {
        const root = await tempDir()
        const github = await skill(root, 'github', 'name: github\ndescription: GitHub URLs and permalinks\nsites: [github.com]', 'SECRET BODY')
        await skill(root, 'notion', 'name: notion\ndescription: Notion\nsites: [notion.so]')
        await skill(root, 'plain', 'name: plain\ndescription: no sites')
        const hints = createSiteHints({ roots: [root] })

        const first = await hints.hintFor('task-1', ['https://github.com/buzzni/happy'])
        expect(first).toEqual({ note: expect.stringContaining('not page content'), skills: [{ name: 'github', description: 'GitHub URLs and permalinks', path: github }] })
        expect(JSON.stringify(first)).not.toContain('SECRET BODY')
        expect(await hints.hintFor('task-1', ['https://github.com/other'])).toBeUndefined()
        expect(await hints.hintFor('task-2', ['https://github.com/'])).toEqual(expect.objectContaining({ skills: [expect.objectContaining({ name: 'github' })] }))
        expect(await hints.hintFor('task-1', ['https://example.com/'])).toBeUndefined()
    })

    it('reads the folders once and survives missing folders, unreadable files and oversized skills', async () => {
        const root = await tempDir()
        await skill(root, 'big', `name: big\ndescription: x\nsites: [big.com]`, 'x'.repeat(70 * 1024))
        await skill(root, 'ok', 'name: ok\ndescription: fine\nsites: [ok.com]')
        await mkdir(join(root, 'dir-as-skill', 'SKILL.md'), { recursive: true })
        const hints = createSiteHints({ roots: [join(root, 'missing'), root] })
        expect(await hints.hintFor('t', ['https://big.com/'])).toBeUndefined()
        expect((await hints.hintFor('t', ['https://ok.com/']))?.skills.map((s) => s.name)).toEqual(['ok'])
        await skill(root, 'late', 'name: late\ndescription: added later\nsites: [late.com]')
        expect(await hints.hintFor('t', ['https://late.com/'])).toBeUndefined()
    })

    it('trims long descriptions and uses the folder name when the skill has none', async () => {
        const root = await tempDir()
        await skill(root, 'folder-name', `description: ${'d'.repeat(500)}\nsites: [a.com]`)
        const hint = await hints(root).hintFor('t', ['https://a.com/'])
        expect(hint?.skills[0].name).toBe('folder-name')
        expect(hint?.skills[0].description).toHaveLength(200)
    })
})

function hints(root: string) {
    return createSiteHints({ roots: [root] })
}
