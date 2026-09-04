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

const TIMEOUT_MS = 3000
/** 이 시간 안에 만료될 grant 는 미리 교환한다. 턴 경계마다 확인하므로 넉넉히 둔다. */
export const REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000

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
 * @returns 교환에 성공해 env 를 갱신했으면 `true`.
 */
export async function refreshMcpCallerGrantIfExpiring(
    token: string,
    machineId: string,
    context: { projectId?: string; now?: number } = {},
): Promise<boolean> {
    const grant = process.env.HAPPY_APLUS_MCP_CALLER_GRANT
    const configUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
    if (!grant || !configUrl || !machineId) return false
    if (!grantExpiresWithin(grant, REFRESH_THRESHOLD_MS, context.now ?? Date.now())) return false

    const refreshUrl = resolveRefreshUrl(configUrl)
    if (!refreshUrl) return false

    // grant 는 발급 시점 scope 에 묶여 있다. 호출부가 추측하지 않고 실제 설정
    // URL 의 scope 를 그대로 쓴다.
    const projectId = context.projectId ?? readConfigProjectId(configUrl)

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
        const res = await fetch(refreshUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Aplus-Machine-Id': machineId,
                'X-Aplus-Caller-Grant': grant,
                ...(projectId ? { 'X-Aplus-Project-Id': projectId } : {}),
            },
            signal: ctl.signal,
        })
        if (!res.ok) {
            // 교환이 거부돼도 기존 grant 는 아직 유효하다. 그대로 쓴다.
            logger.debug(`[aplus] caller grant 교환 거부 ${res.status}`)
            return false
        }
        const body = (await res.json()) as { grant?: unknown }
        if (typeof body?.grant !== 'string' || !body.grant) {
            logger.debug('[aplus] caller grant 교환 응답이 올바르지 않음')
            return false
        }
        process.env.HAPPY_APLUS_MCP_CALLER_GRANT = body.grant
        logger.debug('[aplus] caller grant 교환 완료')
        return true
    } catch {
        logger.debug('[aplus] caller grant 교환 실패 — 기존 grant 유지')
        return false
    } finally {
        clearTimeout(timer)
    }
}
