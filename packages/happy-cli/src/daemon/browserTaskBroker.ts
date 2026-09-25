/**
 * Daemon side of the Agent Browser broker (D4) on the execution machine.
 *
 * When the machine is configured for the browser Runtime
 * (HAPPY_BROWSER_TASK_BROKER_SOCKET + a readable daemon token file), the
 * daemon registers each spawned session with the Runtime broker, hands the
 * session process its per-session secret through the spawn environment,
 * binds the registration once the session reports its Happy session id, and
 * revokes it when the session ends. A failed registration only means the
 * session has no browser grant; it never blocks the spawn.
 *
 * A revocation the Runtime has not confirmed is kept in a file and retried
 * with exponential backoff (at most 5 minutes apart), across daemon restarts,
 * so an ended session's registration cannot stay renewable. The file is
 * replaced durably (exclusive temp file, fsync, rename, directory fsync); a
 * failed write is retried, and a revocation that is neither confirmed nor
 * saved is reported to the caller. An unreadable or malformed queue file is
 * never read as empty: the broker refuses to start (no new browser grants)
 * and the file is left for repair.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { brokerRequest } from '@/browserRuntime/brokerGrantSource'
import { logger } from '@/ui/logger'

const DEFAULT_DAEMON_TOKEN_FILE = '/var/lib/abp/daemon-token'
const MAX_RETRY_DELAY_MS = 5 * 60_000

type RevokeTarget = { registrationId: string } | { agentSessionId: string }

export interface BrowserTaskSessionBroker {
    register(): Promise<{ registrationId: string; sessionSecret: string } | undefined>
    bind(registrationId: string, agentSessionId: string): Promise<boolean>
    /** Tries once now; an unconfirmed revocation stays pending and is retried. */
    revoke(target: RevokeTarget): Promise<void>
    /** Retries every pending revocation once; resolves to how many remain. */
    retryPendingRevocations(): Promise<number>
}

export interface BrowserTaskSessionBrokerOptions {
    /** Pending revocations survive daemon restarts here (the daemon's home dir). */
    pendingRevocationsFile?: string
    /** First retry delay; doubles per failed round up to 5 minutes. */
    retryBaseMs?: number
    /** Replaces the queue file durably; tests inject write failures. */
    writeQueueFile?: (file: string, data: string) => void
}

export class PendingRevocationQueueError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PendingRevocationQueueError'
    }
}

function isRevokeTarget(target: unknown): target is RevokeTarget {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false
    const keys = Object.keys(target)
    const value = Object.values(target)[0]
    return keys.length === 1 && ['registrationId', 'agentSessionId'].includes(keys[0]) && typeof value === 'string' && value.length > 0
}

/** A missing file is an empty queue; anything else that is not a valid queue is an error. */
function loadPending(file: string | undefined): RevokeTarget[] {
    if (!file) return []
    let raw: string
    try {
        raw = readFileSync(file, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw new PendingRevocationQueueError(`Browser task revocation queue ${file} is unreadable`)
    }
    let parsed: { schemaVersion?: unknown; pending?: unknown }
    try {
        parsed = JSON.parse(raw) as typeof parsed
    } catch {
        throw new PendingRevocationQueueError(`Browser task revocation queue ${file} is not valid JSON`)
    }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.pending) || !parsed.pending.every(isRevokeTarget))
        throw new PendingRevocationQueueError(`Browser task revocation queue ${file} has an unsupported format`)
    return parsed.pending
}

/** Exclusive temp file, fsync, rename over `file`, then fsync the directory. */
function writeQueueFileDurably(file: string, data: string): void {
    const dir = dirname(file)
    const temporary = join(dir, `.${basename(file)}.${randomUUID()}.tmp`)
    try {
        const fd = openSync(temporary, 'wx', 0o600)
        try {
            writeFileSync(fd, data)
            fsyncSync(fd)
        } finally {
            closeSync(fd)
        }
        renameSync(temporary, file)
    } catch (error) {
        rmSync(temporary, { force: true })
        throw error
    }
    const dirFd = openSync(dir, 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
}

export function createBrowserTaskSessionBroker(
    env: NodeJS.ProcessEnv = process.env,
    request: typeof brokerRequest = brokerRequest,
    options: BrowserTaskSessionBrokerOptions = {},
): BrowserTaskSessionBroker | undefined {
    const socketPath = env.HAPPY_BROWSER_TASK_BROKER_SOCKET
    if (!socketPath) return undefined
    let daemonToken: string
    try {
        daemonToken = readFileSync(env.HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE || DEFAULT_DAEMON_TOKEN_FILE, 'utf8').trim()
    } catch {
        logger.debug('[DAEMON RUN] Browser task broker configured but the daemon token is unreadable; browser grants disabled')
        return undefined
    }
    if (!daemonToken) return undefined
    const headers = { 'x-abp-daemon-token': daemonToken }
    /** The reply status, or 0 when the socket was unreachable. */
    const send = async (path: string, body: Record<string, unknown>): Promise<{ status: number; result?: Record<string, unknown> }> => {
        try {
            const reply = await request(socketPath, 'POST', path, headers, { schemaVersion: 1, ...body })
            if (reply.status === 200 && reply.body.ok) return { status: 200, result: reply.body.result as Record<string, unknown> }
            // Error codes only: bodies never carry secrets, but keep logs minimal anyway.
            logger.debug(`[DAEMON RUN] Browser task broker ${path} failed status=${reply.status} code=${reply.body.error?.code ?? '-'}`)
            return { status: reply.status }
        } catch (error) {
            logger.debug(`[DAEMON RUN] Browser task broker ${path} unreachable: ${error instanceof Error ? error.message : 'unknown'}`)
            return { status: 0 }
        }
    }
    const call = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => (await send(path, body)).result

    const pendingFile = options.pendingRevocationsFile
    const retryBaseMs = options.retryBaseMs ?? 1_000
    let pending = loadPending(pendingFile)
    const key = (target: RevokeTarget) => JSON.stringify(target)
    const writeQueueFile = options.writeQueueFile ?? writeQueueFileDurably
    /** True while the file lags the in-memory queue (a write failed); retried with the revocations. */
    let queueDirty = false
    const savePending = (): boolean => {
        if (!pendingFile) return true
        try {
            writeQueueFile(pendingFile, JSON.stringify({ schemaVersion: 1, pending }))
            queueDirty = false
            return true
        } catch (error) {
            queueDirty = true
            logger.warn(`[DAEMON RUN] Browser task revocation queue not saved (${(error as NodeJS.ErrnoException).code ?? 'error'}); retrying`)
            return false
        }
    }
    /** Confirmed (200) and invalid requests (400, never retryable) leave the queue. */
    const attempt = async (target: RevokeTarget): Promise<void> => {
        const { status } = await send('/v1/sessions/revoke', { ...target })
        if (status !== 200 && status !== 400) return
        pending = pending.filter((entry) => key(entry) !== key(target))
        savePending()
    }
    let retryTimer: NodeJS.Timeout | undefined
    let failedRounds = 0
    const retryPendingRevocations = async (): Promise<number> => {
        if (queueDirty) savePending()
        for (const target of [...pending]) await attempt(target)
        failedRounds = pending.length || queueDirty ? failedRounds + 1 : 0
        scheduleRetry()
        return pending.length
    }
    const scheduleRetry = (): void => {
        if (retryTimer || (!pending.length && !queueDirty)) return
        retryTimer = setTimeout(() => { retryTimer = undefined; void retryPendingRevocations() },
            Math.min(retryBaseMs * 2 ** Math.max(0, failedRounds - 1), MAX_RETRY_DELAY_MS))
        retryTimer.unref()
    }
    scheduleRetry()

    return {
        async register() {
            const result = await call('/v1/sessions/register', {})
            return typeof result?.registrationId === 'string' && typeof result.sessionSecret === 'string'
                ? { registrationId: result.registrationId, sessionSecret: result.sessionSecret }
                : undefined
        },
        async bind(registrationId, agentSessionId) {
            return Boolean(await call('/v1/sessions/bind', { registrationId, agentSessionId }))
        },
        async revoke(target) {
            let saved = !queueDirty
            if (!pending.some((entry) => key(entry) === key(target))) {
                pending = [...pending, target]
                saved = savePending()
            }
            await attempt(target)
            const outstanding = pending.some((entry) => key(entry) === key(target))
            if (pending.length || queueDirty) failedRounds = Math.max(failedRounds, 1)
            scheduleRetry()
            if (outstanding && !saved) throw new PendingRevocationQueueError('Browser task revocation was neither confirmed nor saved; retrying in memory')
        },
        retryPendingRevocations,
    }
}
