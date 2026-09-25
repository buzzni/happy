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
 * so an ended session's registration cannot stay renewable.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
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
}

function loadPending(file: string | undefined): RevokeTarget[] {
    if (!file) return []
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown; pending?: unknown }
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.pending)) return []
        return parsed.pending.filter((target): target is RevokeTarget => Boolean(target) && typeof target === 'object'
            && (typeof (target as Record<string, unknown>).registrationId === 'string' || typeof (target as Record<string, unknown>).agentSessionId === 'string'))
    } catch {
        return []
    }
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
    const savePending = (): void => {
        if (!pendingFile) return
        try {
            const temporary = `${pendingFile}.${process.pid}.tmp`
            writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, pending }), { mode: 0o600 })
            renameSync(temporary, pendingFile)
        } catch (error) {
            logger.debug(`[DAEMON RUN] Browser task broker pending revocations not saved: ${error instanceof Error ? error.message : 'unknown'}`)
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
        for (const target of [...pending]) await attempt(target)
        failedRounds = pending.length ? failedRounds + 1 : 0
        scheduleRetry()
        return pending.length
    }
    const scheduleRetry = (): void => {
        if (retryTimer || !pending.length) return
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
            if (!pending.some((entry) => key(entry) === key(target))) {
                pending = [...pending, target]
                savePending()
            }
            await attempt(target)
            if (pending.length) failedRounds = Math.max(failedRounds, 1)
            scheduleRetry()
        },
        retryPendingRevocations,
    }
}
