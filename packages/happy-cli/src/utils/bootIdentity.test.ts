import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLinuxBootId } from './bootIdentity'

function procRootWith(bootId: string): string {
    const root = mkdtempSync(join(tmpdir(), 'boot-identity-'))
    mkdirSync(join(root, 'sys/kernel/random'), { recursive: true })
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), bootId)
    return root
}

describe('readLinuxBootId', () => {
    it('reads the trimmed boot id', async () => {
        await expect(readLinuxBootId(procRootWith('6f1c-boot\n'))).resolves.toBe('6f1c-boot')
    })

    it('refuses an empty boot id', async () => {
        await expect(readLinuxBootId(procRootWith('  \n'))).rejects.toThrow('Empty Linux boot id')
    })

    it('rejects when the file is missing', async () => {
        await expect(readLinuxBootId(mkdtempSync(join(tmpdir(), 'boot-identity-none-')))).rejects.toThrow()
    })
})
