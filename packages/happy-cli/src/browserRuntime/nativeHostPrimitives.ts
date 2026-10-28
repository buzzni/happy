import { constants } from 'node:fs'
import { open, lstat, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { projectPath } from '@/projectPath'
import type { SessionOwner } from './sessionRegistration'

interface NativeHostBinding {
    lockWriter(fd: number): void
    processStart(pid: number): string | null
    bootId(): string
}
let binding: NativeHostBinding | undefined
export function nativeHostBindingPath(): string {
    if (!['darwin', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('NATIVE_HOST_UNSUPPORTED')
    return join(projectPath(), 'native', `${process.platform}-${process.arch}`, 'browser-host.node')
}
function native(): NativeHostBinding {
    return binding ??= createRequire(import.meta.url)(nativeHostBindingPath()) as NativeHostBinding
}

export function readNativeBootId(): string {
    const value = native().bootId()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('NATIVE_BOOT_UNKNOWN')
    return value.toLowerCase()
}
export function readNativeSessionOwner(pid: number): SessionOwner | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error('NATIVE_INVALID_PID')
    const bootId = readNativeBootId(), pidStartTime = readNativePidStartTime(pid)
    return pidStartTime === undefined ? undefined : { bootId, pid, pidStartTime }
}

export function readNativePidStartTime(pid: number): string | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error('NATIVE_INVALID_PID')
    const pidStartTime = native().processStart(pid)
    if (pidStartTime === null) return undefined
    if (!/^[0-9]+$/.test(pidStartTime)) throw new Error('NATIVE_PROCESS_UNKNOWN')
    return pidStartTime
}

/** The service must own the parent directory. Hold this descriptor until runtime
 * shutdown: no helper lifetime, PID lock, heartbeat or env flag can replace it. */
export async function acquireNativeWriterLock(path: string): Promise<{ close(): Promise<void> }> {
    let file: FileHandle | undefined
    try {
        const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
        if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('NATIVE_LOCK_UNSAFE')
        file = await open(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
        native().lockWriter(file.fd)
        const opened = await file.stat(), current = await lstat(path)
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('NATIVE_LOCK_CHANGED')
        let closing: Promise<void> | undefined
        const held = file
        return { close: () => closing ??= held.close() }
    } catch (error) { await file?.close(); throw error }
}
