import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
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
const nativeCatalog = z.object({ data: z.array(z.object({ cwd: z.string(), skills: z.array(z.unknown()) })) })

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
    return enabledSkills(response, cwd).filter(skill => !userOnly || skill.scope !== 'repo').map(skill => ({
        ref: skillRef(skill, machineId, cwd),
        name: skill.name,
        label: (skill.interface?.displayName || skill.name).slice(0, 256),
        description: (skill.interface?.shortDescription || skill.shortDescription || skill.description || '').slice(0, 500),
        plugin: skill.pluginId?.split('@')[0]?.slice(0, 150) ?? null,
        scope: skill.scope,
    }))
}

export function resolveCodexSkill(response: unknown, machineId: string, cwd: string, ref: string) {
    const skill = enabledSkills(response, cwd).find(entry => skillRef(entry, machineId, cwd) === ref)
    return skill ? { type: 'skill' as const, name: skill.name, path: skill.path } : null
}

export function createCodexSkillListHandler(deps: {
    machineId: string
    allowedRoot: string
    approvedRoots: () => readonly string[]
    isShared: () => Promise<boolean>
    createClient: () => Pick<CodexAppServerClient, 'connect' | 'disconnect' | 'listSkills'>
}) {
    let busy = false
    return async (payload: unknown) => {
        const input = rpcInput.safeParse(payload)
        if (!input.success || await deps.isShared()) return { status: 'unavailable' }
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
                if (!nativeCatalog.safeParse(result).success) return { status: 'unsupported' }
                return { version: 1, status: 'ready', skills: catalogCodexSkills(result, deps.machineId, cwd, input.data.cwd === null) }
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
