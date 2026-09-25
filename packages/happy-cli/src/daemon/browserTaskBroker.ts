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
 */
import { readFileSync } from 'node:fs'
import { brokerRequest } from '@/browserRuntime/brokerGrantSource'
import { logger } from '@/ui/logger'

const DEFAULT_DAEMON_TOKEN_FILE = '/var/lib/abp/daemon-token'

export interface BrowserTaskSessionBroker {
    register(): Promise<{ registrationId: string; sessionSecret: string } | undefined>
    bind(registrationId: string, agentSessionId: string): Promise<boolean>
    revoke(target: { registrationId: string } | { agentSessionId: string }): Promise<void>
}

export function createBrowserTaskSessionBroker(
    env: NodeJS.ProcessEnv = process.env,
    request: typeof brokerRequest = brokerRequest,
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
    const call = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
        try {
            const reply = await request(socketPath, 'POST', path, headers, { schemaVersion: 1, ...body })
            if (reply.status === 200 && reply.body.ok) return reply.body.result as Record<string, unknown>
            // Error codes only: bodies never carry secrets, but keep logs minimal anyway.
            logger.debug(`[DAEMON RUN] Browser task broker ${path} failed status=${reply.status} code=${reply.body.error?.code ?? '-'}`)
        } catch (error) {
            logger.debug(`[DAEMON RUN] Browser task broker ${path} unreachable: ${error instanceof Error ? error.message : 'unknown'}`)
        }
        return undefined
    }
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
            await call('/v1/sessions/revoke', { ...target })
        },
    }
}
