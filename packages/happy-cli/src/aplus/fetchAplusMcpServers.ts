/**
 * Aplus auto-mcp-config fetcher — specs/20260525-company-mcp-server P6(b).
 *
 * 부트 시 web-ui (`/api/me/mcp-config`) 에 happyToken 으로 GET → 응답의
 * `mcpServers` 를 그대로 각 agent runner 의 mcpServers 에 머지한다.
 *
 * 동작 정책:
 *  - `HAPPY_APLUS_MCP_CONFIG_URL` 가 설정돼 있을 때만 시도 — 미설정이면 no-op.
 *  - 실패해도 throw 하지 않는다 (graceful degrade). MCP 가 없을 뿐 세션은 정상.
 *  - 타임아웃 3 초 (사용자 부트 체감 지연 최소화).
 */

import { logger } from '@/ui/logger'

type McpHttpServerEntry = {
    type: 'http'
    url: string
    headers?: Record<string, string>
}

export type AplusMcpServersMap = Record<string, McpHttpServerEntry>

export type AplusMcpServersFetchResult =
    | { ok: true; servers: AplusMcpServersMap }
    | {
        ok: false
        reason: 'not-configured' | 'missing-machine-id' | 'http-error' | 'invalid-response' | 'timeout' | 'network-error'
        error: string
    }

const TIMEOUT_MS = 3000

export async function fetchAplusMcpServersResult(token: string, machineId: string): Promise<AplusMcpServersFetchResult> {
    const configUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
    if (!configUrl) {
        logger.debug('[aplus] HAPPY_APLUS_MCP_CONFIG_URL 미설정 — aplus MCP 자동등록 skip')
        return { ok: false, reason: 'not-configured', error: 'mcp-config URL is not configured' }
    }
    if (!machineId) {
        logger.debug('[aplus] machineId 없음 — aplus MCP 자동등록 skip')
        return { ok: false, reason: 'missing-machine-id', error: 'machineId is missing' }
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    const callerGrant = process.env.HAPPY_APLUS_MCP_CALLER_GRANT
    try {
        const res = await fetch(configUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Aplus-Machine-Id': machineId,
                ...(callerGrant ? { 'X-Aplus-Caller-Grant': callerGrant } : {}),
            },
            signal: ctl.signal,
        })
        if (!res.ok) {
            logger.debug(`[aplus] mcp-config 응답 ${res.status} — skip`)
            return { ok: false, reason: 'http-error', error: `mcp-config responded with ${res.status}` }
        }
        const body = (await res.json()) as { mcpServers?: AplusMcpServersMap }
        if (!body?.mcpServers || typeof body.mcpServers !== 'object') {
            logger.debug('[aplus] mcp-config 응답에 mcpServers 없음 — skip')
            return { ok: false, reason: 'invalid-response', error: 'mcp-config response is invalid' }
        }
        const keys = Object.keys(body.mcpServers)
        logger.debug(`[aplus] mcp-config 받음 — 등록: ${keys.join(', ')}`)
        return { ok: true, servers: body.mcpServers }
    } catch (e) {
        const timedOut = ctl.signal.aborted
        logger.debug(`[aplus] mcp-config fetch 실패 — skip: ${timedOut ? 'timeout' : 'network error'}`)
        return timedOut
            ? { ok: false, reason: 'timeout', error: 'mcp-config request timed out' }
            : { ok: false, reason: 'network-error', error: 'mcp-config network request failed' }
    } finally {
        clearTimeout(timer)
    }
}

export async function fetchAplusMcpServers(token: string, machineId: string): Promise<AplusMcpServersMap> {
    const result = await fetchAplusMcpServersResult(token, machineId)
    return result.ok ? result.servers : {}
}
