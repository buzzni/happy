import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBrowserTaskBootId, readBrowserTaskPidStartTime, readBrowserTaskSessionOwner } from './browserTaskSessionOwner'

const native = vi.hoisted(() => ({ readNativeBootId: vi.fn(), readNativePidStartTime: vi.fn() }))
vi.mock('@/browserRuntime/nativeHostPrimitives', () => native)
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe.each(['darwin', 'win32'])('browser process identity on %s', platform => {
    function host() { vi.stubGlobal('process', { ...process, platform }) }

    it('uses the kernel boot and exact creation identity without numeric truncation', async () => {
        host()
        native.readNativeBootId.mockReturnValue('current-boot')
        native.readNativePidStartTime.mockReturnValue('132123456789012345')
        expect(await readBrowserTaskSessionOwner(42)).toEqual({ bootId: 'current-boot', pid: 42, pidStartTime: '132123456789012345' })
        expect(native.readNativePidStartTime).toHaveBeenCalledWith(42)
    })

    it('propagates unknown liveness and boot lookup failures; only explicit absence means dead', async () => {
        host()
        native.readNativeBootId.mockReturnValue('current-boot')
        native.readNativePidStartTime.mockImplementation(() => { throw new Error('NATIVE_PROCESS_UNKNOWN') })
        await expect(readBrowserTaskSessionOwner(42)).rejects.toThrow('NATIVE_PROCESS_UNKNOWN')
        native.readNativePidStartTime.mockReturnValue(undefined)
        expect(await readBrowserTaskSessionOwner(42)).toBeUndefined()
        native.readNativeBootId.mockImplementation(() => { throw new Error('NATIVE_BOOT_UNKNOWN') })
        await expect(readBrowserTaskBootId()).rejects.toThrow('NATIVE_BOOT_UNKNOWN')
    })

    it('keeps explicit Linux procfs paths independent of the test host', async () => {
        host()
        const root = await mkdtemp(join(tmpdir(), 'abp-owner-'))
        cleanups.push(() => rm(root, { recursive: true, force: true }))
        await mkdir(join(root, 'sys/kernel/random'), { recursive: true })
        await mkdir(join(root, '42'))
        await writeFile(join(root, 'sys/kernel/random/boot_id'), 'linux-boot\n')
        await writeFile(join(root, '42/stat'), `42 (name (with) spaces) S ${Array(18).fill('0').join(' ')} 9876543210123456789 0\n`)
        expect(await readBrowserTaskSessionOwner(42, root)).toEqual({ bootId: 'linux-boot', pid: 42, pidStartTime: '9876543210123456789' })
        expect(native.readNativeBootId).not.toHaveBeenCalled()
        expect(native.readNativePidStartTime).not.toHaveBeenCalled()
        await writeFile(join(root, '42/stat'), 'malformed')
        await expect(readBrowserTaskPidStartTime(42, root)).rejects.toThrow('Invalid Linux process stat')
        expect(await readBrowserTaskPidStartTime(43, root)).toBeUndefined()
    })

    it.each([0, -1, 1.5, NaN, Infinity, 2 ** 31])('rejects invalid pid %s before OS access', async pid => {
        host()
        await expect(readBrowserTaskPidStartTime(pid)).rejects.toThrow('Invalid session pid')
        expect(native.readNativePidStartTime).not.toHaveBeenCalled()
    })
})
