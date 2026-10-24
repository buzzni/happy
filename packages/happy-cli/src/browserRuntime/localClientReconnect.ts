import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
/** Reconnect with proof read from a private descriptor, never from model-written arguments. */
import { constants } from 'node:fs'
import { open, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, relative, resolve, isAbsolute } from 'node:path'
import { readBrowserClientDescriptor, browserClientBrokerCall } from '../commands/browserClientCommand'
export async function reconnectLocalClient(options: { cwd: string; socketPath: string; sessionSecret: string; profileId: string }, outFile: string, leaseMinutes: 15 | 60 | 1440, signal?: AbortSignal, call = browserClientBrokerCall) {
    if (process.platform !== 'linux') throw new Error('Connection issuance currently requires Linux')
    const root = await realpath(options.cwd), file = await realpath(resolve(root, outFile)), parent = dirname(file), rel = relative(root, file)
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Invalid project scope')
    signal?.throwIfAborted()
    const git = promisify(execFile)
    const inRepo = await git('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']).then(r => r.stdout.trim() === 'true', e => { if (e.code === 128) return false; throw e })
    if (inRepo) await git('git', ['-C', root, 'check-ignore', '--no-index', '-q', '--', file])
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const pinned = `/proc/self/fd/${directory.fd}/${basename(file)}`
    const temporary = `${pinned}.${randomUUID()}.tmp`, lock = `${pinned}.reconnect-lock`
    let held = false, created: Record<string, any> | undefined
    try {
        const reservation = await open(lock, 'wx', 0o600); held = true; await reservation.close()
        const descriptor = await readBrowserClientDescriptor(pinned)
        if (descriptor.schemaVersion !== 2 || descriptor.projectRoot !== root || descriptor.outFile !== file
            || descriptor.brokerSocket !== options.socketPath || descriptor.profileId !== options.profileId) throw new Error('Descriptor scope mismatch')
        const before = await stat(pinned), pinnedParent = await directory.stat()
        created = await call(options.socketPath, 'v2:connect-app', options.sessionSecret, {
            schemaVersion: 2, requestId: randomUUID(), appId: descriptor.appId, appSecret: descriptor.appSecret, profileId: descriptor.profileId,
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
        // The replaced connection may still be valid. Retire it without extending its lease.
        await call(options.socketPath, 'v2:revoke', descriptor.clientSecret, { schemaVersion: 2 }).catch(() => undefined)
        return { ok: true, file, appId: descriptor.appId, expiresAtMs: created.expiresAtMs }
    } catch (error) {
        if (created?.clientSecret) await call(options.socketPath, 'v2:revoke', created.clientSecret, { schemaVersion: 2 }).catch(() => undefined)
        throw error
    } finally {
        await rm(temporary, { force: true }); if (held) await rm(lock, { force: true }); await directory.close()
    }
}
