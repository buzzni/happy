/**
 * The kernel's boot identity: different after every reboot, the same for every
 * process within one boot. Lets a recorded pid be told apart from the same pid
 * handed out again after a reboot.
 *
 * Shares format and rules with Saycode Desktop's process identity (ADR-041) —
 * not code: darwin `kern.bootsessionuuid`, linux `/proc/sys/kernel/random/boot_id`,
 * and nothing on Windows, which compares exact process creation times instead.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function readLinuxBootId(procRoot = '/proc'): Promise<string> {
    const bootId = (await readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim()
    if (!bootId) throw new Error('Empty Linux boot id')
    return bootId
}
