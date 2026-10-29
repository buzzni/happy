import { constants } from 'node:fs'
import { open, lstat, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname, isAbsolute, normalize } from 'node:path'
import { projectPath } from '@/projectPath'
import type { SessionOwner } from './sessionRegistration'

interface NativeHostBinding {
    lockWriter(fd: number): void
    processStart(pid: number): string | null
    bootId(): string
    verifyRootOwned(fd: number): void
    processPrincipal(pid: number): string | null
    verifyServiceFile(fd: number, sid: string, privateFile: boolean): void
    verifyPrivateDirectory(fd: number, uid: number): void
    verifyPublicDirectory(fd: number, uid: number): void
    dropMacIdentity(uid: number, gid: number): void
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

/** macOS effective UID or Windows token-user SID; never a display name. */
export function readNativeProcessPrincipal(pid: number): string | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error('NATIVE_INVALID_PID')
    const principal = native().processPrincipal(pid)
    if (principal === null) return undefined
    if (process.platform === 'win32' ? !/^S-1-[0-9]+(?:-[0-9]+){1,15}$/.test(principal)
        : !/^(0|[1-9][0-9]{0,9})$/.test(principal) || Number(principal) > 0xffffffff) throw new Error('NATIVE_PROCESS_UNKNOWN')
    return principal
}

/** The caller holds this descriptor while reading; parents must be verified by
 * the service before opening. This check never repairs a permissive ACL. */
export function verifyWindowsServiceFile(file: FileHandle, serviceSid: string, privateFile: boolean): void {
    if (process.platform !== 'win32') throw new Error('NATIVE_PATH_VERIFIER_UNSUPPORTED')
    native().verifyServiceFile(file.fd, serviceSid, privateFile)
}

/** Check every component without following symlinks. A privileged administrator
 * can still replace root-owned code; ordinary users cannot replace any ancestor. */
export async function verifyMacServiceExecutable(path: string): Promise<void> {
    await verifyMacRootPath(path, 'executable')
}
export async function verifyMacServiceFile(path: string): Promise<void> { await verifyMacRootPath(path, 'file') }
async function verifyMacRootPath(path: string, kind: 'executable' | 'file' | 'directory'): Promise<void> {
    if (process.platform !== 'darwin' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) throw new Error('NATIVE_PATH_UNTRUSTED')
    const components: string[] = []
    for (let current = path; ; current = dirname(current)) { components.unshift(current); if (current === '/') break }
    for (const component of components) {
        const file = await open(component, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
            const info = await file.stat()
            if (component === path && kind !== 'directory' ? !info.isFile() || (kind === 'executable' && !(info.mode & 0o111)) : !info.isDirectory()) throw new Error('NATIVE_PATH_UNTRUSTED')
            native().verifyRootOwned(file.fd)
        } finally { await file.close() }
    }
}

/** Fixed service directories have root-protected parents and no inherited ACLs. */
export async function verifyMacPrivateDirectory(path: string, uid: number, publicDirectory = false): Promise<void> {
    if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) throw new Error('NATIVE_PATH_UNTRUSTED')
    await verifyMacRootPath(dirname(path), 'directory')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { if (publicDirectory) native().verifyPublicDirectory(file.fd, uid); else native().verifyPrivateDirectory(file.fd, uid) } finally { await file.close() }
}

/** Must run before parsing any browser response or opening the task API. */
export function dropMacServiceIdentity(uid: number, gid: number): void { native().dropMacIdentity(uid, gid) }

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
