import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDirectory } from './syncDirectory'

const platform = process.platform
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }) })

describe('syncDirectory', () => {
    it('syncs a real directory and reports a missing one', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-sync-'))
        try {
            await expect(syncDirectory(dir)).resolves.toBeUndefined()
            await expect(syncDirectory(join(dir, 'missing'))).rejects.toThrow()
        } finally { await rm(dir, { recursive: true, force: true }) }
    })
    it('never opens a directory handle on Windows, where fsync on it fails with EPERM', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        await expect(syncDirectory('/does/not/exist')).resolves.toBeUndefined()
    })
})
