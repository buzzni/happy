import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { BrowserRuntimeError, type BrowserInstanceId } from './contracts'
import { CdpConnection } from './drivers/cdpConnection'
import { CdpDriver } from './drivers/cdpDriver'
import { readNativeSessionOwner, readNativeProcessPrincipal } from './nativeHostPrimitives'
import type { SessionOwner } from './sessionRegistration'

// A normalized reply from the OS protection service, not from Chrome or an agent.
// Strings preserve full OS counter precision (UInt64 must not pass through JS Number).
const protectionSchema = z.object({
    version: z.literal(1), identity: z.string().min(1).max(256), epoch: z.string().min(1).max(256),
    generation: z.string().min(1).max(256), violations: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    enforcing: z.literal(true),
}).strict()
type Protection = z.infer<typeof protectionSchema>
export interface NativeBrowserSessionOptions {
    /** Descriptors and exact identity captured by the protected service at launch. */
    input: Writable
    output: Readable
    owner: SessionOwner
    protection: { mode: 'basic'; identity: string } | {
        mode?: 'guard'
        identity: string
        epoch: string
        /** Authenticated OS channel. A missing/unreadable reply is never readiness. */
        snapshot(): Promise<unknown>
    }
    /** Terminate the owned process tree using the service's original process handle,
     * and resolve only after exit. Never look up and kill a replacement by PID. */
    terminate(): Promise<void>
    checkIntervalMs?: number
    checkTimeoutMs?: number
    setAllowedOrigins?: (origins: readonly string[]) => void
    maxAgentWindows?: number
}
export interface NativeBrowserSession {
    driver: CdpDriver
    /** Resolves only after termination was attempted; false requires service recovery. */
    stopped: Promise<{ terminated: boolean }>
    check(): Promise<void>
    close(): Promise<{ terminated: boolean }>
}
const unavailable = () => new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'Native browser protection or process identity could not be verified', false, false)
const terminationUnknown = () => new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'Native browser termination could not be confirmed', false, true)

function deadline<T>(operation: () => Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(unavailable()), ms)
        Promise.resolve().then(operation).then(resolve, reject).finally(() => clearTimeout(timer))
    })
}

/** Owns one browser lifetime. It cannot reconnect or switch to a network endpoint.
 * The service supplies protected descriptors and an authenticated guard; this module
 * does not provision identities/ACLs or replace independent OS network enforcement. */
export async function openNativeBrowserSession(options: NativeBrowserSessionOptions,
    dependencies: { readOwner?: typeof readNativeSessionOwner; readPrincipal?: (pid: number) => string | undefined } = {}): Promise<NativeBrowserSession> {
    const interval = options.checkIntervalMs ?? 1000, timeout = options.checkTimeoutMs ?? 3000
    if (!Number.isSafeInteger(interval) || interval < 10 || interval > 5000 ||
        !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 10_000) throw new Error('Invalid native browser monitor limits')
    const owner = { ...options.owner }
    // Pin the selected mode for this lifetime. A lost guard never becomes basic.
    const protection = { ...options.protection }
    const guard = protection.mode === 'basic' ? undefined : protection
    const readOwner = dependencies.readOwner ?? readNativeSessionOwner
    const readPrincipal = dependencies.readPrincipal ?? readNativeProcessPrincipal
    const connection = CdpConnection.fromPipe(options.input, options.output)
    const browserInstanceId = `native-${createHash('sha256').update(JSON.stringify([owner.bootId, owner.pid, owner.pidStartTime])).digest('hex')}` as BrowserInstanceId
    let closed = false, consumed = false, baseline: Protection | undefined
    let checking: Promise<void> | undefined, closing: Promise<{ terminated: boolean }> | undefined
    let monitor: ReturnType<typeof setInterval> | undefined
    let resolveStopped!: (result: { terminated: boolean }) => void
    const stopped = new Promise<{ terminated: boolean }>(resolve => { resolveStopped = resolve })
    const driver = new CdpDriver({ setAllowedOrigins: options.setAllowedOrigins, maxAgentWindows: options.maxAgentWindows, connectPipe: async () => {
        if (closed || consumed) throw unavailable()
        consumed = true
        await check()
        return { connection, browserInstanceId }
    } })
    const close = (): Promise<{ terminated: boolean }> => {
        if (closing) return closing
        // Latch admission before any asynchronous cleanup, including close callbacks.
        closed = true
        clearInterval(monitor)
        closing = Promise.resolve().then(async () => {
            try { await deadline(() => options.terminate(), timeout); return { terminated: true } }
            catch { return { terminated: false } }
        }).then(result => { resolveStopped(result); return result })
        connection.close()
        void driver.close()
        return closing
    }
    const verify = async () => {
        if (closed) throw unavailable()
        if (guard) {
            const status = protectionSchema.parse(await deadline(() => guard.snapshot(), timeout))
            if (closed || status.identity !== guard.identity || status.epoch !== guard.epoch) throw unavailable()
            if (baseline && (status.generation !== baseline.generation || status.violations !== baseline.violations)) throw unavailable()
            baseline ??= status
        }
        const current = readOwner(owner.pid)
        if (!current || current.bootId !== owner.bootId || current.pid !== owner.pid || current.pidStartTime !== owner.pidStartTime) throw unavailable()
        if (readPrincipal(owner.pid) !== protection.identity) throw unavailable()
        // The UID/SID query must describe the same lifetime, not a replacement PID.
        const after = readOwner(owner.pid)
        if (!after || after.bootId !== owner.bootId || after.pid !== owner.pid || after.pidStartTime !== owner.pidStartTime) throw unavailable()
    }
    function check(): Promise<void> {
        if (closed) return Promise.reject(unavailable())
        if (checking) return checking
        checking = verify().catch(async () => { const result = await close(); throw result.terminated ? unavailable() : terminationUnknown() }).finally(() => { checking = undefined })
        return checking
    }
    connection.onClose(() => { void close() })
    try {
        await driver.connect()
        await check()
        monitor = setInterval(() => { void check().catch(() => {}) }, interval)
        monitor.unref()
        return { driver, stopped, check, close }
    } catch {
        const result = await close()
        throw result.terminated ? unavailable() : terminationUnknown()
    }
}
