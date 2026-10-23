/**
 * The kernel's boot identity: different after every reboot, the same for every
 * process within one boot. Lets a recorded pid be told apart from the same pid
 * handed out again after a reboot.
 *
 * Shares format and rules with Saycode Desktop's process identity (ADR-041) —
 * not code: darwin `kern.bootsessionuuid`, linux `/proc/sys/kernel/random/boot_id`,
 * and nothing on Windows, which compares exact process creation times instead.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function readLinuxBootId(procRoot = '/proc'): Promise<string> {
    const bootId = (await readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim()
    if (!bootId) throw new Error('Empty Linux boot id')
    return bootId
}

let cachedBootId: { value: string | undefined } | undefined

/**
 * This boot's identity, read once per process. Undefined on Windows and
 * whenever the platform does not answer — callers treat that as "unknown".
 */
export function readCurrentBootIdSync(
    deps: { platform?: NodeJS.Platform; procRoot?: string; sysctl?: () => string } = {},
): string | undefined {
    const useCache = Object.keys(deps).length === 0
    if (useCache && cachedBootId) return cachedBootId.value
    const platform = deps.platform ?? process.platform
    let value: string | undefined
    try {
        if (platform === 'darwin') {
            value = (deps.sysctl ?? (() => execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], {
                encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
            })))().trim() || undefined
        } else if (platform === 'linux') {
            value = readFileSync(join(deps.procRoot ?? '/proc', 'sys/kernel/random/boot_id'), 'utf8').trim() || undefined
        }
    } catch {
        value = undefined
    }
    if (useCache) cachedBootId = { value }
    return value
}
