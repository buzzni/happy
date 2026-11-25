import { describe, expect, it, vi } from 'vitest'
import { catalogCodexSkills, createCodexSkillListHandler, resolveCodexSkill } from './codexSkillCatalog'

const cwd = '/project'
const skills = [
    { name: 'new', description: 'Project version', path: '/project/.agents/skills/new/SKILL.md', scope: 'repo', enabled: true },
    { name: 'new', description: 'Plugin version', path: '/home/user/.codex/plugins/cache/personal/osk/v1/skills/new/SKILL.md', scope: 'user', enabled: true, pluginId: 'osk@personal' },
    { name: 'disabled', path: '/home/user/.agents/skills/disabled/SKILL.md', scope: 'user', enabled: false },
]
const response = { data: [{ cwd, skills }] }

describe('Codex skill references', () => {
    it('returns only enabled entries, without paths, and resolves the selected duplicate', () => {
        const entries = catalogCodexSkills(response, 'pc', cwd)
        expect(entries).toHaveLength(2)
        expect(entries[1]).toMatchObject({ name: 'new', plugin: 'osk', description: 'Plugin version' })
        expect(JSON.stringify(entries)).not.toContain('/home')
        expect(resolveCodexSkill(response, 'pc', cwd, entries[1].ref)).toEqual({ type: 'skill', name: 'new', path: skills[1].path })
        expect(resolveCodexSkill(response, 'another-pc', cwd, entries[1].ref)).toBeNull()
        expect(resolveCodexSkill({ data: [{ cwd, skills: [skills[0]] }] }, 'pc', cwd, entries[1].ref)).toBeNull()
    })

    it('binds repository skills to the catalog folder and omits them before a personal chat has a folder', () => {
        const entries = catalogCodexSkills(response, 'pc', cwd)
        const other = '/other'
        expect(resolveCodexSkill({ data: [{ cwd: other, skills }] }, 'pc', other, entries[0].ref)).toBeNull()
        expect(catalogCodexSkills(response, 'pc', cwd, true)).toEqual([entries[1]])
    })

    it('rejects shared PCs and out-of-scope directories before opening app-server', async () => {
        const createClient = vi.fn()
        const deps = { machineId: 'pc', allowedRoot: cwd, approvedRoots: () => [], createClient }
        const shared = createCodexSkillListHandler({ ...deps, isShared: async () => true })
        expect(await shared({ cwd })).toEqual({ status: 'unavailable' })
        const personal = createCodexSkillListHandler({ ...deps, isShared: async () => false })
        expect(await personal({ cwd: '/unapproved' })).toEqual({ status: 'unavailable' })
        expect(createClient).not.toHaveBeenCalled()
    })
})
