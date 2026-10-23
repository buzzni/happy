/**
 * 살아있는 세션의 caller grant 교환.
 *
 * grant 는 spawn/resume 때 child env 에 한 번 주입되고 끝이다. 기본 수명이
 * 24시간이므로, 그보다 오래 사는 child 는 그 뒤로 mcp-config 조회가 403 이
 * 되고 마지막 정상 설정에 갇힌다. 그 설정 안의 커넥터 capability 토큰도 같은
 * 24시간에 만료되므로 커넥터부터 죽는다.
 *
 * 만료된 뒤에 되살리는 것이 아니라 **만료 전에 미리 교환한다**. 서버는 유효한
 * grant 만 교환해주고, 최초 발급 시점 기준 체인 상한을 넘으면 거부한다.
 */

import { logger } from '@/ui/logger'
import { createSerialLock, credentialFingerprint, recoverCredential, RefreshFailure } from '@/utils/refreshRecovery'

/** 턴 시작을 오래 붙잡지 않도록 갱신 상한(45초, C-R2)보다 짧게 둔다. */
const TIMEOUT_MS = 3000
/** 이 시간 안에 만료될 grant 는 미리 교환한다. 턴 경계마다 확인하므로 넉넉히 둔다. */
export const REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000
/**
 * 턴이 없는 세션의 확인 주기. 턴 경계만 기다리면 창(2시간) 동안 쉬던 세션의
 * grant 가 만료되고, 서버는 만료된 grant 를 되살려주지 않는다. 확인 자체는
 * 로컬 파싱이라 창 밖에서는 네트워크를 쓰지 않는다.
 */
export const REFRESH_CHECK_INTERVAL_MS = 15 * 60 * 1000

function readGrantExpiry(grant: string): number | null {
    const encoded = grant.split('.')[0]
    if (!encoded) return null
    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp?: unknown }
        return typeof payload?.exp === 'number' ? payload.exp : null
    } catch {
        return null
    }
}

export function grantExpiresWithin(grant: string, withinMs: number, now: number): boolean {
    const exp = readGrantExpiry(grant)
    if (exp === null) return false
    return exp - now <= withinMs
}

function readConfigProjectId(configUrl: string): string | undefined {
    try {
        return new URL(configUrl).searchParams.get('project_id')?.trim() || undefined
    } catch {
        return undefined
    }
}

function resolveRefreshUrl(configUrl: string): string | null {
    try {
        const parsed = new URL(configUrl)
        parsed.search = ''
        parsed.pathname = parsed.pathname.replace(/\/mcp-config\/?$/, '/mcp-caller-grant/refresh')
        return parsed.toString()
    } catch {
        return null
    }
}

/**
 * 교환 거절 중 grant 자체가 더는 교환될 수 없다는 뜻인 것: 만료됐거나 체인 상한(7일)에
 * 닿았거나 서명이 틀렸다. 같은 grant 로는 다시 시도해도 낫지 않는다. 그 밖의 거절(세션
 * 매핑·권한 조회 등)은 나중에 다시 시도한다.
 */
const NOT_RENEWABLE_ERRORS = new Set(['Caller grant is not renewable', 'caller_grant_not_renewable', 'invalid_caller_grant'])
/** 공통 분류에서 영구로 읽히는 OAuth 코드로 옮긴다. */
const NOT_RENEWABLE_CODE = 'invalid_grant'

/** 대화를 다시 시작해야 커넥터 권한이 돌아올 때 세션에 남기는 알림. Desktop 이 이 원문으로 번역한다. */
export const CALLER_GRANT_EXPIRED_NOTICE = 'Connector access for this conversation has expired. Start the conversation again to restore it.'

/** 타이머·턴 경계·도구가 같은 grant 를 동시에 교환하지 않게 프로세스 안에서 하나씩 실행한다. */
const exchangeLock = createSerialLock()
let expiredListener: (() => void) | null = null

/**
 * grant 가 영구히 교환되지 않게 된 순간(지문당 한 번) 부를 함수를 등록한다.
 *
 * @returns 등록을 푸는 함수.
 */
export function onMcpCallerGrantExpired(listener: () => void): () => void {
    expiredListener = listener
    return () => {
        if (expiredListener === listener) expiredListener = null
    }
}

async function readRefusalCode(res: Response): Promise<string | undefined> {
    try {
        const body = (await res.json()) as { error?: unknown }
        return typeof body?.error === 'string' && NOT_RENEWABLE_ERRORS.has(body.error) ? NOT_RENEWABLE_CODE : undefined
    } catch {
        return undefined
    }
}

/**
 * @returns 교환에 성공해 env 를 갱신했으면 `true`.
 */
export async function refreshMcpCallerGrantIfExpiring(
    token: string,
    machineId: string,
    context: { projectId?: string; sessionId?: string; now?: number } = {},
): Promise<boolean> {
    const grant = process.env.HAPPY_APLUS_MCP_CALLER_GRANT
    const configUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
    if (!grant || !configUrl || !machineId) return false
    if (!grantExpiresWithin(grant, REFRESH_THRESHOLD_MS, context.now ?? Date.now())) return false

    // grant 는 발급 시점 scope 에 묶여 있다. 호출부가 추측하지 않고 실제 설정
    // URL 의 scope 를 그대로 쓴다.
    const projectId = context.projectId ?? readConfigProjectId(configUrl)
    const sessionBound = Boolean(projectId && context.sessionId)
    let refreshUrl = resolveRefreshUrl(configUrl)
    if (!refreshUrl) return false
    if (sessionBound) {
        refreshUrl = new URL(`/api/projects/${encodeURIComponent(projectId!)}/lesson-host/refresh`, refreshUrl).toString()
    }
    const exchangeUrl = refreshUrl
    const fingerprint = (value: string) => credentialFingerprint('mcp-caller-grant', machineId, value)
    // 401 은 grant 가 아니라 machine 토큰의 거절이다. 영구로 세어 다시 POST 하지 않지만, "대화를 다시
    // 시작하면 복구돼요" 안내는 grant 자체가 교환 불가일 때만 맞다.
    let grantNotRenewable = false

    const outcome = await recoverCredential<string>({
        read: async () => process.env.HAPPY_APLUS_MCP_CALLER_GRANT || null,
        fingerprint,
        refresh: async (current, signal) => {
            const res = await fetch(exchangeUrl, {
                method: 'POST',
                redirect: 'error',
                ...(sessionBound ? { body: JSON.stringify({ machineId, sessionId: context.sessionId, callerGrant: current }) } : {}),
                headers: {
                    ...(sessionBound ? { 'Content-Type': 'application/json' } : {}),
                    'Authorization': `Bearer ${token}`,
                    'X-Aplus-Machine-Id': machineId,
                    'X-Aplus-Caller-Grant': current,
                    ...(projectId ? { 'X-Aplus-Project-Id': projectId } : {}),
                },
                signal,
            })
            if (!res.ok) {
                // 교환이 거부돼도 기존 grant 는 아직 유효할 수 있다. 그대로 쓴다.
                const code = res.status === 403 ? await readRefusalCode(res) : undefined
                grantNotRenewable = code === NOT_RENEWABLE_CODE
                throw new RefreshFailure({ status: res.status, code })
            }
            const body = (await res.json()) as { grant?: unknown }
            if (typeof body?.grant !== 'string' || !body.grant) throw new Error('caller grant 교환 응답이 올바르지 않음')
            return body.grant
        },
        write: async (next) => {
            process.env.HAPPY_APLUS_MCP_CALLER_GRANT = next
        },
    }, fingerprint(grant), { lock: exchangeLock, refreshTimeoutMs: TIMEOUT_MS })

    if (outcome.status === 'failed' && outcome.classification === 'permanent' && !outcome.cached) {
        logger.debug(`[aplus] caller grant 교환 영구 실패 (${grantNotRenewable ? 'grant 교환 불가' : 'machine 토큰 거절'})`)
        if (grantNotRenewable) expiredListener?.()
    }
    return outcome.status === 'refreshed'
}

/**
 * 턴과 무관하게 주기적으로 `refresh` 를 부른다. 실패는 다음 주기에 다시
 * 시도하고, 느린 교환이 끝나기 전에는 겹쳐 부르지 않는다.
 *
 * @returns 타이머를 멈추는 함수.
 */
export function startMcpCallerGrantRefreshTimer(
    refresh: () => Promise<unknown>,
    intervalMs = REFRESH_CHECK_INTERVAL_MS,
): () => void {
    let running = false
    const timer = setInterval(() => {
        if (running) return
        running = true
        void refresh()
            .catch(() => logger.debug('[aplus] caller grant 주기 교환 실패 — 다음 주기에 재시도'))
            .finally(() => { running = false })
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
}
