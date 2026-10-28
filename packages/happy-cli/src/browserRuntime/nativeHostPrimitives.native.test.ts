import { spawn, spawnSync } from 'node:child_process'
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireNativeWriterLock, nativeHostBindingPath, readNativeSessionOwner, readNativePidStartTime, readNativeBootId, verifyMacServiceExecutable, readNativeProcessPrincipal } from './nativeHostPrimitives'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work() })
const directory = async () => {
    const value = await mkdtemp(join(tmpdir(), 'abp-native-'))
    cleanup.push(() => rm(value, { recursive: true, force: true }))
    return value
}
// These assertions use the kernel, not a mocked lock implementation.
describe.skipIf(!['darwin', 'win32'].includes(process.platform))('native browser host primitives', () => {
    it.skipIf(process.platform !== 'darwin')('accepts protected system executables and rejects user-writable helper ancestry', async () => {
        expect(readNativeProcessPrincipal(process.pid)).toBe(String(process.geteuid!()))
        await expect(verifyMacServiceExecutable('/usr/bin/true')).resolves.toBeUndefined()
        const dir = await directory(), path = join(dir, 'helper')
        await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
        await expect(verifyMacServiceExecutable(path)).rejects.toThrow()
        await symlink('/usr/bin/true', join(dir, 'linked-helper'))
        await expect(verifyMacServiceExecutable(join(dir, 'linked-helper'))).rejects.toThrow()
        await expect(verifyMacServiceExecutable('/usr/bin/../bin/true')).rejects.toThrow()
    })

    it('keeps the writer lock in the runtime process after the acquisition call returns', async () => {
        const path = join(await directory(), 'writer.lock')
        const lock = await acquireNativeWriterLock(path)
        const contender = () => spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const host = require(process.argv[1]);
            const fd = fs.openSync(process.argv[2], 'r+');
            try { host.lockWriter(fd); process.exitCode = 0; }
            catch(e) { process.stdout.write(e.code); process.exitCode = 1; }
            finally { fs.closeSync(fd); }
        `, nativeHostBindingPath(), path], { encoding: 'utf8', timeout: 5000 })
        try {
            const refused = contender()
            expect(refused.status).toBe(1)
            expect(refused.stdout).toBe('NATIVE_LOCK_BUSY')
        } finally { await lock.close() }
        expect(contender().status).toBe(0)
        await lock.close() // Explicit shutdown is idempotent.
    })

    it.skipIf(process.platform !== 'darwin')('refuses symlink and writable-by-others lock files', async () => {
        const dir = await directory(), target = join(dir, 'target'), linked = join(dir, 'link')
        await writeFile(target, '', { mode: 0o666 })
        await chmod(target, 0o666)
        await expect(acquireNativeWriterLock(target)).rejects.toThrow()
        await symlink(target, linked)
        await expect(acquireNativeWriterLock(linked)).rejects.toThrow()
    })

    it('rejects hardlinked lock files on the host filesystem', async () => {
        const dir = await directory(), target = join(dir, 'target')
        await writeFile(target, '', { mode: 0o600 })
        await link(target, join(dir, 'alias'))
        await expect(acquireNativeWriterLock(target)).rejects.toThrow('NATIVE_LOCK_UNSAFE')
    })

    it('keeps the lock until the owner exits, then lets a new runtime acquire it', async () => {
        const path = join(await directory(), 'writer.lock')
        const child = spawn(process.execPath, ['-e', `
            const fs = require('node:fs');
            const fd = fs.openSync(process.argv[2], 'w+', 0o600);
            require(process.argv[1]).lockWriter(fd);
            process.stdout.write('ready');
            setInterval(() => {}, 1000);
        `, nativeHostBindingPath(), path], { stdio: ['ignore', 'pipe', 'ignore'] })
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
        cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
        await new Promise<void>((resolve, reject) => {
            child.once('error', reject)
            child.stdout!.once('data', () => resolve())
            child.once('exit', () => reject(new Error('Lock owner exited before ready')))
        })
        await expect(acquireNativeWriterLock(path)).rejects.toThrow('NATIVE_LOCK_BUSY')
        child.kill('SIGKILL'); await exited
        const recovered = await acquireNativeWriterLock(path)
        await recovered.close()
    })

    it('identifies real processes across calls and proves absence only after exit', async () => {
        const own = readNativePidStartTime(process.pid)!
        expect(own).toMatch(/^\d+$/)
        expect(readNativePidStartTime(process.pid)).toBe(own)
        const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(()=>{}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
        cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
        await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout!.once('data', () => resolve()) })
        expect(readNativePidStartTime(child.pid!)).toMatch(/^\d+$/)
        expect(readNativePidStartTime(child.pid!)).not.toBe(own)
        child.kill(); await exited
        expect(readNativePidStartTime(child.pid!)).toBeUndefined()
        expect(() => readNativePidStartTime(-1)).toThrow()
    })

    it('reads a kernel boot identity shared by separate processes', () => {
        const own = readNativeSessionOwner(process.pid)!
        expect(own.bootId).toBe(readNativeBootId())
        const child = spawnSync(process.execPath, ['-e',
            'process.stdout.write(require(process.argv[1]).bootId())', nativeHostBindingPath()],
            { encoding: 'utf8', timeout: 5000 })
        expect(child.status).toBe(0)
        expect(child.stdout.toLowerCase()).toBe(own.bootId)
    })
})
