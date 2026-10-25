import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
/** Reconnect with proof read from a private descriptor, never from model-written arguments. */
import { constants } from 'node:fs'
import { open, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, relative, resolve, isAbsolute } from 'node:path'
import { readBrowserClientDescriptor, browserClientBrokerCall } from '../commands/browserClientCommand'
/** Keep the inode stable: the kernel releases this lock even after SIGKILL. */
async function acquireReconnectLock(file: string): Promise<() => Promise<void>> {
    const handle = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0
            || (process.getuid && metadata.uid !== process.getuid())) throw new Error('Invalid reconnect lock')
        // The helper inherits only the lock FD. Closing its stdin, including parent death, releases flock.
        const holder = spawn('/usr/bin/flock', ['-n', '-E', '75', '/proc/self/fd/3', process.execPath, '-e',
            'process.stdout.write("locked\\n"); process.stdin.resume()'], { env: {}, stdio: ['pipe', 'pipe', 'ignore', handle.fd] })
        holder.stdin!.on('error', () => {})
        try {
            await new Promise<void>((resolve, reject) => {
                let output = ''
                const timer = setTimeout(() => reject(new Error('Reconnect lock timed out')), 5000)
                timer.unref()
                const fail = () => { clearTimeout(timer); reject(new Error('Reconnect already running or flock unavailable')) }
                holder.once('error', fail)
                holder.once('exit', fail)
                holder.stdout!.on('data', (chunk: Buffer) => {
                    output += chunk.toString()
                    if (output.includes('locked\n')) { clearTimeout(timer); resolve() }
                })
            })
        } catch (error) { holder.stdin!.destroy(); holder.kill(); throw error }
        return async () => {
            const exited = holder.exitCode !== null || holder.signalCode !== null ? Promise.resolve()
                : new Promise<void>(resolve => holder.once('exit', () => resolve()))
            holder.stdin!.end()
            await exited
            await handle.close()
        }
    } catch (error) { await handle.close(); throw error }
}
export async function reconnectLocalClient(options: { cwd: string; socketPath: string; sessionSecret: string; profileId: string }, outFile: string, leaseMinutes: 15 | 60 | 1440, signal?: AbortSignal, call = browserClientBrokerCall) {
    if (process.platform !== 'linux') throw new Error('Connection issuance currently requires Linux')
    const root = await realpath(options.cwd), file = await realpath(resolve(root, outFile)), parent = dirname(file), rel = relative(root, file)
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Invalid project scope')
    signal?.throwIfAborted()
    const git = promisify(execFile)
    const inRepo = await git('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']).then(r => r.stdout.trim() === 'true', e => { if (e.code === 128) return false; throw e })
    const temporaryName = `${basename(file)}.${randomUUID()}.tmp`
    if (inRepo) for (const candidate of [file, resolve(parent, temporaryName)])
        await git('git', ['-C', root, 'check-ignore', '--no-index', '-q', '--', candidate])
            .catch(() => { throw new Error('Connection and reconnect temporary files must be ignored by Git') })
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const pinned = `/proc/self/fd/${directory.fd}/${basename(file)}`
    const temporary = `/proc/self/fd/${directory.fd}/${temporaryName}`, lock = `${pinned}.reconnect-lock`
    let releaseLock: (() => Promise<void>) | undefined, created: Record<string, any> | undefined
    try {
        releaseLock = await acquireReconnectLock(lock)
        signal?.throwIfAborted()
        const descriptor = await readBrowserClientDescriptor(pinned)
        if (descriptor.schemaVersion !== 2 || descriptor.projectRoot !== root || descriptor.outFile !== file
            || descriptor.brokerSocket !== options.socketPath || descriptor.profileId !== options.profileId) throw new Error('Descriptor scope mismatch')
        const before = await stat(pinned), pinnedParent = await directory.stat()
        created = await call(options.socketPath, 'v2:connect-app', options.sessionSecret, {
            schemaVersion: 2, requestId: randomUUID(), requestedAtMs: Date.now(), appId: descriptor.appId, appSecret: descriptor.appSecret, profileId: descriptor.profileId,
            taskSpaceId: descriptor.taskSpaceId, projectRoot: root, outFile: file, origins: descriptor.origins, leaseMinutes,
        })
        signal?.throwIfAborted()
        const fd = await open(temporary, 'wx', 0o600)
        try { await fd.writeFile(JSON.stringify({ ...descriptor, clientSessionId: created.clientSessionId, clientSecret: created.clientSecret, expiresAtMs: created.expiresAtMs }) + '\n'); await fd.sync() } finally { await fd.close() }
        const after = await stat(pinned), currentParent = await stat(parent)
        if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || pinnedParent.ino !== currentParent.ino
            || pinnedParent.dev !== currentParent.dev || await realpath(parent) !== parent) throw new Error('Descriptor changed during reconnect')
        signal?.throwIfAborted()
        await rename(temporary, pinned); await directory.sync()
        signal?.throwIfAborted()
        // The replaced connection may still be valid. Retire it without extending its lease.
        await call(options.socketPath, 'v2:revoke', descriptor.clientSecret, { schemaVersion: 2 }).catch(() => undefined)
        signal?.throwIfAborted()
        return { ok: true, file, appId: descriptor.appId, expiresAtMs: created.expiresAtMs }
    } catch (error) {
        if (created?.clientSecret) await call(options.socketPath, 'v2:revoke', created.clientSecret, { schemaVersion: 2 }).catch(() => undefined)
        throw error
    } finally {
        await rm(temporary, { force: true }); await releaseLock?.(); await directory.close()
    }
}
