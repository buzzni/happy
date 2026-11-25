import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { validatePath } from '@/modules/common/pathSecurity'
import type { CodexAppServerClient } from './codexAppServerClient'

export class CodexSkillUnavailableError extends Error {}

export const codexSkillRefSchema = z.string().regex(/^[a-f0-9]{64}$/)
const rpcInput = z.object({ cwd: z.string().max(4096).nullable() }).strict()
const nativeSkill = z.object({
    name: z.string().min(1).max(256),
    description: z.string().optional(),
    shortDescription: z.string().optional(),
    interface: z.object({ displayName: z.string().nullish(), shortDescription: z.string().nullish() }).nullish(),
    path: z.string().min(1).max(4096),
    scope: z.enum(['user', 'repo', 'system', 'admin']),
    enabled: z.literal(true),
    pluginId: z.string().nullish(),
})
const nativeCatalog = z.object({ data: z.array(z.object({
    cwd: z.string(), skills: z.array(z.unknown()), errors: z.array(z.unknown()).optional(),
})) })

function enabledSkills(response: unknown, cwd: string) {
    const catalog = nativeCatalog.safeParse(response)
    return (catalog.success ? catalog.data.data.find(row => row.cwd === cwd)?.skills ?? [] : []).flatMap(value => {
        const skill = nativeSkill.safeParse(value)
        return skill.success && isAbsolute(skill.data.path) ? [skill.data] : []
    })
}

function skillRef(skill: z.infer<typeof nativeSkill>, machineId: string, cwd: string): string {
    return createHash('sha256').update(JSON.stringify([
        machineId, skill.scope === 'repo' ? cwd : null, skill.scope, skill.pluginId ?? null, skill.name, skill.path,
    ])).digest('hex')
}

export function catalogCodexSkills(response: unknown, machineId: string, cwd: string, userOnly = false) {
    const entries = enabledSkills(response, cwd).filter(skill => !userOnly || skill.scope !== 'repo')
        .map(skill => ({
            path: skill.path,
            ref: skillRef(skill, machineId, cwd),
            name: skill.name,
            label: (skill.interface?.displayName || skill.name).slice(0, 256),
            description: (skill.interface?.shortDescription || skill.shortDescription || skill.description || '').slice(0, 500),
            plugin: skill.pluginId?.slice(0, 150) ?? null,
            scope: skill.scope,
        }))
    const sourceKey = (skill: Pick<typeof entries[number], 'label' | 'plugin' | 'scope'>) => JSON.stringify([skill.label, skill.plugin ?? skill.scope])
    const counts = new Map<string, number>()
    const indexes = new Map<string, number>()
    for (const entry of entries) {
        const key = sourceKey(entry)
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return entries.map(({ path, ...entry }) => {
        const key = sourceKey(entry)
        if (counts.get(key) === 1) return entry
        const index = (indexes.get(key) ?? 0) + 1
        indexes.set(key, index)
        const parts = dirname(path).split(sep)
        const marker = parts.lastIndexOf('.agents')
        const folder = entry.scope === 'repo' && marker > 0 ? relative(cwd, parts.slice(0, marker).join(sep) || sep) || '.' : null
        const segments = folder?.split(sep) ?? []
        const outside = segments.includes('..') && segments.some(segment => segment !== '..')
        const localFolder = folder && !isAbsolute(folder) && !outside ? folder : null
        return { ...entry, sourceHint: [localFolder, `#${index}`].filter(Boolean).join(' ').slice(-150) }
    })
}

export function resolveCodexSkill(response: unknown, machineId: string, cwd: string, ref: string) {
    const skill = enabledSkills(response, cwd).find(entry => skillRef(entry, machineId, cwd) === ref)
    return skill ? { type: 'skill' as const, name: skill.name, path: skill.path } : null
}

export function createCodexSkillListHandler(deps: {
    machineId: string
    allowedRoot: string
    approvedRoots: () => readonly string[]
    isOrganizationMachine: () => Promise<boolean>
    createClient: () => Pick<CodexAppServerClient, 'connect' | 'disconnect' | 'listSkills'>
}) {
    let busy = false
    return async (payload: unknown) => {
        const input = rpcInput.safeParse(payload)
        if (!input.success || await deps.isOrganizationMachine().catch(() => true)) return { status: 'unavailable' }
        if (busy) return { status: 'failed' }
        busy = true
        try {
            const requested = input.data.cwd ?? deps.allowedRoot
            const approved = deps.approvedRoots()
            if (!isAbsolute(requested) || !validatePath(requested, deps.allowedRoot, approved).valid) return { status: 'unavailable' }
            const cwd = await realpath(requested)
            const root = await realpath(deps.allowedRoot)
            const roots = (await Promise.all(approved.map(path => realpath(path).catch(() => null)))).filter(path => path !== null)
            if (!validatePath(cwd, root, roots).valid || !(await stat(cwd)).isDirectory()) return { status: 'unavailable' }
            const client = deps.createClient()
            try {
                await client.connect()
                const result = await client.listSkills(cwd)
                const catalog = nativeCatalog.safeParse(result)
                if (!catalog.success) return { status: 'unsupported' }
                const row = catalog.data.data.find(entry => entry.cwd === cwd)
                const skills = catalogCodexSkills(result, deps.machineId, cwd, input.data.cwd === null)
                if (!row || (!skills.length && row.errors?.length)) return { status: 'failed' }
                return { version: 1, status: 'ready', skills }
            } finally {
                await client.disconnect()
            }
        } catch (error) {
            return { status: error instanceof Error && /not installed|method not found|unknown method/i.test(error.message) ? 'unsupported' : 'failed' }
        } finally {
            busy = false
        }
    }
}
