import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCurrentBootIdSync, readLinuxBootId } from './bootIdentity'

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

describe('readCurrentBootIdSync', () => {
    it('reads kern.bootsessionuuid on darwin', () => {
        expect(readCurrentBootIdSync({ platform: 'darwin', sysctl: () => 'ABC-UUID\n' })).toBe('ABC-UUID')
    })

    it('reads /proc boot_id on linux', () => {
        expect(readCurrentBootIdSync({ platform: 'linux', procRoot: procRootWith('linux-boot\n') })).toBe('linux-boot')
    })

    it('records nothing on Windows', () => {
        expect(readCurrentBootIdSync({ platform: 'win32' })).toBeUndefined()
    })

    it('is undefined when the platform does not answer', () => {
        expect(readCurrentBootIdSync({ platform: 'darwin', sysctl: () => { throw new Error('no sysctl') } })).toBeUndefined()
    })
})
