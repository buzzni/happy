/**
 * aplus-dev-studio specs/org-agent-plan §6.3-2 — the `happy codex` runner's plan branch.
 *
 * 1. Read and delete the daemon's spawn seeds (descriptor + grant secret) and check the descriptor's canonical
 *    shape. A descriptor that does not pass stops the runner; it never falls back to the machine's own Codex
 *    login or the multi-auth proxy.
 * 2. Exchange the grant for an `agps_` session key right away, binding this Happy session id on the server at
 *    spawn time (a first message ten minutes later would otherwise miss the grant's bind deadline). Up to two
 *    short retries for a transient failure, then `agent_plan_bind_failed`.
 * 3. Keep the key fresh before it expires and serve it to Codex through the local proxy.
 */
import { randomBytes } from 'node:crypto'
import { readTrustedStudioOrigin } from '@/daemon/setupTokenBindingProof'
import {
    AGENT_PLAN_DESCRIPTOR_ENV,
    AGENT_PLAN_PROXY_KEY_ENV,
    AGENT_PLAN_SECRET_ENV,
    AgentPlanLaunchError,
    agentPlanCodexArgs,
    agentPlanGatewayResponsesUrl,
    agentPlanSessionKeysUrl,
    readAgentPlanDescriptor,
    type AgentPlanDescriptor,
} from '@/launcher/agentPlanLaunch'
import { HAPPY_AI_AUTH_CONNECTION_VERSION_ENV, HAPPY_AI_AUTH_SOURCE_ENV } from '@/usage/aiAuthSource'
import { startAgentPlanProxy } from './agentPlanProxy'

const SECRET = /^[A-Za-z0-9_-]{16,200}$/
const KEY_EXCHANGE_TIMEOUT_MS = 15_000
/** Refresh this long before `agps_` expires (keys live 30 minutes). */
const REFRESH_MARGIN_MS = 5 * 60_000
const DEFAULT_RETRY_DELAYS_MS = [500, 1_500] as const

export type AgentPlanLaunch = { descriptor: AgentPlanDescriptor; secret: string }

export type AgentPlanSessionKey = { key: string; expiresAt: number }

/** A refused or failed exchange. `transient` failures are worth retrying; a refusal is final. */
export class AgentPlanKeyExchangeError extends Error {
    constructor(readonly code: string, readonly transient: boolean) {
        super(code)
        this.name = 'AgentPlanKeyExchangeError'
    }
}

/**
 * The spawn seeds, read once and deleted. `null` when this is not a plan launch; throws when it is one that
 * cannot be honoured (half the seeds, or a descriptor this contract did not write).
 */
export function consumeAgentPlanLaunch(env: NodeJS.ProcessEnv): AgentPlanLaunch | null {
    const rawDescriptor = env[AGENT_PLAN_DESCRIPTOR_ENV]
    const secret = env[AGENT_PLAN_SECRET_ENV]
    delete env[AGENT_PLAN_DESCRIPTOR_ENV]
    delete env[AGENT_PLAN_SECRET_ENV]
    if (rawDescriptor === undefined && secret === undefined) return null
    if (rawDescriptor === undefined || secret === undefined || !SECRET.test(secret)) {
        throw new AgentPlanLaunchError('agent_plan_descriptor_invalid', 'incomplete plan launch')
    }
    return { descriptor: readAgentPlanDescriptor(rawDescriptor, readTrustedStudioOrigin(env)), secret }
}

/** One `POST /api/agent-plan/session-keys`. */
export async function exchangeAgentPlanSessionKey(input: {
    url: string
    grantId: string
    secret: string
    sessionId: string
    now: number
    fetchImpl?: typeof fetch
}): Promise<AgentPlanSessionKey> {
    let response: Response
    try {
        response = await (input.fetchImpl ?? fetch)(input.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grantId: input.grantId, secret: input.secret, sessionId: input.sessionId }),
            redirect: 'error',
            signal: AbortSignal.timeout(KEY_EXCHANGE_TIMEOUT_MS),
        })
    } catch {
        throw new AgentPlanKeyExchangeError('agent_plan_unreachable', true)
    }
    let body: unknown
    try {
        body = await response.json()
    } catch {
        body = null
    }
    const fields = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    if (!response.ok) {
        const code = typeof fields.error === 'string' && /^[a-z_]{1,64}$/.test(fields.error) ? fields.error : `http_${response.status}`
        throw new AgentPlanKeyExchangeError(code, response.status >= 500 || response.status === 429)
    }
    if (typeof fields.key !== 'string' || !fields.key.startsWith('agps_')
        || typeof fields.expiresAt !== 'number' || !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= input.now) {
        throw new AgentPlanKeyExchangeError('agent_plan_key_invalid', true)
    }
    return { key: fields.key, expiresAt: fields.expiresAt }
}

/**
 * Holds the current `agps_` key. `start()` is the pre-emptive bind; `current()` refreshes once inside the
 * margin, one exchange at a time, and keeps serving a still-valid key when a refresh fails.
 */
export function createAgentPlanKeySource(options: {
    exchange: () => Promise<AgentPlanSessionKey>
    now?: () => number
    retryDelaysMs?: readonly number[]
    sleep?: (ms: number) => Promise<void>
}) {
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    let held: AgentPlanSessionKey | null = null
    let refreshing: Promise<AgentPlanSessionKey> | null = null

    const refresh = (): Promise<AgentPlanSessionKey> => {
        if (!refreshing) {
            refreshing = options.exchange()
                .then((next) => { held = next; return next })
                .finally(() => { refreshing = null })
        }
        return refreshing
    }

    return {
        async start(): Promise<void> {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    await refresh()
                    return
                } catch (error) {
                    const failure = error instanceof AgentPlanKeyExchangeError ? error : new AgentPlanKeyExchangeError('agent_plan_unreachable', true)
                    if (!failure.transient || attempt >= retryDelays.length) {
                        throw new AgentPlanLaunchError('agent_plan_bind_failed', failure.code)
                    }
                    await sleep(retryDelays[attempt]!)
                }
            }
        },
        async current(): Promise<string> {
            if (held && now() < held.expiresAt - REFRESH_MARGIN_MS) return held.key
            try {
                return (await refresh()).key
            } catch (error) {
                if (held && now() < held.expiresAt) return held.key
                throw error
            }
        },
    }
}

export type AgentPlanSession = {
    /** The Codex `-c` arguments: plan provider through the local proxy, grant model, context, web search off. */
    providerArgs: string[]
    close(): Promise<void>
}

/**
 * Binds the session and opens the proxy. On success the proxy client key is in `env` (the runner's own
 * `process.env`), which Codex inherits through `sanitizeChildEnv(..., in-session)`; the grant secret and
 * `agps_` stay in this process's memory.
 */
export async function startAgentPlanSession(input: {
    launch: AgentPlanLaunch
    sessionId: string
    env: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    retryDelaysMs?: readonly number[]
}): Promise<AgentPlanSession> {
    const { descriptor, secret } = input.launch
    const keys = createAgentPlanKeySource({
        exchange: () => exchangeAgentPlanSessionKey({
            url: agentPlanSessionKeysUrl(descriptor),
            grantId: descriptor.grantId,
            secret,
            sessionId: input.sessionId,
            now: Date.now(),
            fetchImpl: input.fetchImpl,
        }),
        retryDelaysMs: input.retryDelaysMs,
    })
    await keys.start()
    const clientKey = randomBytes(32).toString('base64url')
    let proxy: Awaited<ReturnType<typeof startAgentPlanProxy>>
    try {
        proxy = await startAgentPlanProxy({
            upstreamUrl: agentPlanGatewayResponsesUrl(descriptor),
            clientKey,
            sessionKey: () => keys.current(),
            fetchImpl: input.fetchImpl,
        })
    } catch (error) {
        throw new AgentPlanLaunchError('agent_plan_proxy_failed', error instanceof Error ? error.message : String(error))
    }
    input.env[AGENT_PLAN_PROXY_KEY_ENV] = clientKey
    return {
        providerArgs: agentPlanCodexArgs(descriptor, `${proxy.baseUrl}/v1`),
        close: () => proxy.close(),
    }
}

/**
 * spec §6.3-3: `platform-plan` is reported only once Codex was actually started with the plan provider. Until
 * then the run carries what the daemon wrote (it never claims the plan). A plan session whose Codex came up
 * without the provider must not run at all — it would be spending the machine's own login.
 */
export function reportAgentPlanApplied(env: NodeJS.ProcessEnv, applied: boolean): void {
    if (!applied) throw new AgentPlanLaunchError('agent_plan_not_applied')
    env[HAPPY_AI_AUTH_SOURCE_ENV] = 'platform-plan'
    // Written empty, like the daemon does: no connection version belongs to the plan.
    env[HAPPY_AI_AUTH_CONNECTION_VERSION_ENV] = ''
}
