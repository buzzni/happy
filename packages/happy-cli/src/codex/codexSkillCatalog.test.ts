import { realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { catalogCodexSkills, createCodexSkillListHandler, resolveCodexSkill } from './codexSkillCatalog'

const cwd = resolve('/project')
const skills = [
    { name: 'new', description: 'Project version', path: join(cwd, '.agents/skills/new/SKILL.md'), scope: 'repo', enabled: true },
    { name: 'new', description: 'Plugin version', path: resolve('/home/user/.codex/plugins/cache/personal/osk/v1/skills/new/SKILL.md'), scope: 'user', enabled: true, pluginId: 'osk@personal' },
    { name: 'disabled', path: resolve('/home/user/.agents/skills/disabled/SKILL.md'), scope: 'user', enabled: false },
]
const response = { data: [{ cwd, skills }] }

describe('Codex skill references', () => {
    it('returns only enabled entries, without paths, and resolves the selected duplicate', () => {
        const entries = catalogCodexSkills(response, 'pc', cwd)
        expect(entries).toHaveLength(2)
        expect(entries[1]).toMatchObject({ name: 'new', plugin: 'osk@personal', description: 'Plugin version' })
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

    it('distinguishes same-name project skills at different folder levels without absolute paths', () => {
        const nested = join(cwd, 'packages/app')
        const nestedSkills = [skills[0], { ...skills[0], path: join(nested, '.agents/skills/new/SKILL.md') },
            { ...skills[0], path: resolve('/private/outside/.agents/skills/new/SKILL.md') }]
        const entries = catalogCodexSkills({ data: [{ cwd: nested, skills: nestedSkills }] }, 'pc', nested)
        expect(entries).toMatchObject([{ sourceHint: `..${sep}.. #1` }, { sourceHint: '. #2' }, { sourceHint: '#3' }])
        expect(JSON.stringify(entries)).not.toContain('/project')
        expect(JSON.stringify(entries)).not.toContain('outside')
    })

    it('distinguishes a native load failure from an empty catalog without returning native paths', async () => {
        const realCwd = await realpath(process.cwd())
        const listSkills = vi.fn()
        const handler = createCodexSkillListHandler({
            machineId: 'pc', allowedRoot: realCwd, approvedRoots: () => [],
            isOrganizationMachine: async () => false,
            createClient: () => ({ connect: vi.fn(), disconnect: vi.fn(), listSkills }),
        })
        listSkills.mockResolvedValueOnce({ data: [{ cwd: realCwd, skills: [], errors: [{ path: '/private/SKILL.md', message: 'invalid' }] }] })
        expect(await handler({ cwd: realCwd })).toEqual({ status: 'failed' })
        listSkills.mockResolvedValueOnce({ data: [] })
        expect(await handler({ cwd: realCwd })).toEqual({ status: 'failed' })
        listSkills.mockResolvedValueOnce({ data: [{ cwd: realCwd, skills: [] }] })
        expect(await handler({ cwd: realCwd })).toEqual({ status: 'ready', version: 1, skills: [] })
    })

    it('rejects organization PCs and out-of-scope directories before opening app-server', async () => {
        const createClient = vi.fn()
        const deps = { machineId: 'pc', allowedRoot: cwd, approvedRoots: () => [], createClient }
        const shared = createCodexSkillListHandler({ ...deps, isOrganizationMachine: async () => true })
        expect(await shared({ cwd })).toEqual({ status: 'unavailable' })
        const personal = createCodexSkillListHandler({ ...deps, isOrganizationMachine: async () => false })
        expect(await personal({ cwd: '/unapproved' })).toEqual({ status: 'unavailable' })
        expect(createClient).not.toHaveBeenCalled()
    })
})
