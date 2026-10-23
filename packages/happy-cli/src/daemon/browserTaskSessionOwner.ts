/** Linux host process identity for browser registrations, independent of daemon lifetime. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionOwner } from '@/browserRuntime/sessionRegistration'
import { readLinuxBootId } from '@/utils/bootIdentity'

export const readBrowserTaskBootId = readLinuxBootId

/** ENOENT alone proves absence; permissions, malformed data and I/O errors remain unknown. */
export async function readBrowserTaskPidStartTime(pid: number, procRoot = '/proc'): Promise<string | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid session pid')
    let stat: string
    try {
        stat = await readFile(join(procRoot, String(pid), 'stat'), 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
    // comm (field 2) can contain spaces and ')'; fields after its final ')' start at field 3.
    const end = stat.lastIndexOf(')')
    const startTime = stat.slice(end + 1).trim().split(/\s+/)[19]
    if (end < 0 || !startTime || !/^\d+$/.test(startTime)) throw new Error('Invalid Linux process stat')
    return startTime
}

export async function readBrowserTaskSessionOwner(pid: number, procRoot = '/proc'): Promise<SessionOwner | undefined> {
    const bootId = await readBrowserTaskBootId(procRoot)
    const pidStartTime = await readBrowserTaskPidStartTime(pid, procRoot)
    return pidStartTime === undefined ? undefined : { bootId, pid, pidStartTime }
}
