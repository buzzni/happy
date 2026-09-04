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
import type { McpRuntimeServerStatus } from '@slopus/happy-wire'

type McpHttpServerEntry = {
    type: 'http'
    url: string
    headers?: Record<string, string>
}

export type AplusMcpServersMap = Record<string, McpHttpServerEntry>

type MissingMcpService = {
    name: string
    reason: string
}

export type AplusMcpServersFetchResult =
    | { ok: true; servers: AplusMcpServersMap }
    | {
        ok: false
        reason: 'not-configured' | 'missing-machine-id' | 'http-error' | 'invalid-response' | 'timeout' | 'network-error'
        error: string
    }
    | {
        ok: false
        reason: 'connector-config-missing'
        error: string
        expected: string[]
        configured: string[]
        missing: string[]
    }
    | {
        ok: false
        reason: 'mcp-config-missing'
        error: string
        expected: string[]
        configured: string[]
        missing: MissingMcpService[]
    }

export function mcpConfigFailureStatuses(
    result: AplusMcpServersFetchResult,
    checkedAt = Date.now(),
): McpRuntimeServerStatus[] {
    if (result.ok || result.reason === 'not-configured' || result.reason === 'missing-machine-id') {
        return []
    }
    if (result.reason === 'connector-config-missing') {
        return result.missing.map((provider) => ({
            name: provider,
            status: 'connector-config-missing',
            error: result.error,
            checkedAt,
        }))
    }
    if (result.reason === 'mcp-config-missing') {
        return result.missing.map(({ name, reason }) => ({
            name,
            status: reason === 'connector-config-missing'
                ? 'connector-config-missing'
                : 'mcp-config-missing',
            error: result.error,
            checkedAt,
        }))
    }
    return [{
        name: 'aplus-config',
        status: 'config-fetch-failed',
        error: result.error,
        checkedAt,
    }]
}

const TIMEOUT_MS = 3000

export type McpFetchContext = {
    sessionId?: string
    lifecycle?: 'spawn' | 'resume' | 'turn'
    configUrl?: string
    projectId?: string
    callerGrant?: string
    expectedConnectors?: string[]
}

function readExpectedNames(envName: string): string[] {
    try {
        const parsed = JSON.parse(process.env[envName] ?? '[]') as unknown
        if (!Array.isArray(parsed)) return []
        return [...new Set(parsed.filter(
            (provider): provider is string => typeof provider === 'string' && /^[a-z0-9-]{1,64}$/.test(provider),
        ))].sort()
    } catch {
        return []
    }
}

export function readExpectedConnectors(): string[] {
    return readExpectedNames('HAPPY_APLUS_EXPECTED_CONNECTORS')
}

export function readExpectedMcpServices(): string[] {
    return readExpectedNames('HAPPY_APLUS_EXPECTED_MCP_SERVICES')
}

/**
 * 대화를 열 때 있던 MCP 중 세션 동안 지켜야 할 이름.
 *
 * 조직 등록 MCP 는 외부 URL 을 정적 헤더로 직접 호출하므로, 조직이 사용을
 * 중단해도 이미 세션에 들어온 엔트리는 계속 동작한다. 중단을 다음 대화부터
 * 적용하는 편이 살아있는 대화에서 도구가 통째로 사라지는 것보다 낫다.
 *
 * 커넥터는 제외한다. 재연결이 필요해진 커넥터는 게이트웨이가 거부하므로
 * 유지해봐야 죽은 툴만 남는다.
 */
export function resolveMcpFloorServerNames(
    sessionStartServers: AplusMcpServersMap,
    sessionStartConnectors: string[],
): string[] {
    const connectors = new Set(sessionStartConnectors)
    return Object.keys(sessionStartServers).filter((name) => !connectors.has(name)).sort()
}

function correlationValue(value: string | undefined): string | undefined {
    const normalized = value?.trim()
    return normalized && /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : undefined
}

function connectorNames(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null
    if (value.some((provider) => typeof provider !== 'string' || !/^[a-z0-9-]{1,64}$/.test(provider))) {
        return null
    }
    return [...new Set(value)].sort()
}

function missingMcpServices(value: unknown): MissingMcpService[] | null {
    if (!Array.isArray(value)) return null
    const missing: MissingMcpService[] = []
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') return null
        const { name, reason } = entry as { name?: unknown; reason?: unknown }
        if (
            typeof name !== 'string'
            || !/^[a-z0-9-]{1,64}$/.test(name)
            || typeof reason !== 'string'
            || !/^[a-z0-9-]{1,64}$/.test(reason)
        ) {
            return null
        }
        missing.push({ name, reason })
    }
    return missing
}

export type AplusMcpConfigSnapshot = {
    result: AplusMcpServersFetchResult
    servers: AplusMcpServersMap
}

function snapshot(
    result: AplusMcpServersFetchResult,
    servers: AplusMcpServersMap = {},
): AplusMcpConfigSnapshot {
    return { result, servers }
}

export async function fetchAplusMcpConfigSnapshot(
    token: string,
    machineId: string,
    context: McpFetchContext = {},
): Promise<AplusMcpConfigSnapshot> {
    const configuredUrl = context.configUrl ?? process.env.HAPPY_APLUS_MCP_CONFIG_URL
    if (!configuredUrl) {
        logger.debug('[aplus] HAPPY_APLUS_MCP_CONFIG_URL 미설정 — aplus MCP 자동등록 skip')
        return snapshot({ ok: false, reason: 'not-configured', error: 'mcp-config URL is not configured' })
    }
    if (!machineId) {
        logger.debug('[aplus] machineId 없음 — aplus MCP 자동등록 skip')
        return snapshot({ ok: false, reason: 'missing-machine-id', error: 'machineId is missing' })
    }
    let configUrl: string
    try {
        const parsed = new URL(configuredUrl)
        if (context.projectId) parsed.searchParams.set('project_id', context.projectId)
        configUrl = parsed.toString()
    } catch {
        return snapshot({ ok: false, reason: 'not-configured', error: 'mcp-config URL is invalid' })
    }
    const callerGrant = context.callerGrant ?? process.env.HAPPY_APLUS_MCP_CALLER_GRANT
    const expected = context.expectedConnectors ?? readExpectedConnectors()
    const sessionId = correlationValue(context.sessionId)
    const lifecycle = context.lifecycle
        ?? (process.env.HAPPY_APLUS_MCP_INITIAL_LIFECYCLE === 'resume' ? 'resume' : undefined)
        ?? (process.env.HAPPY_APLUS_MCP_INITIAL_LIFECYCLE === 'spawn' ? 'spawn' : undefined)

    for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
        try {
            const res = await fetch(configUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Aplus-Machine-Id': machineId,
                    ...(callerGrant ? { 'X-Aplus-Caller-Grant': callerGrant } : {}),
                    ...(expected.length > 0 ? { 'X-Aplus-Expected-Connectors': expected.join(',') } : {}),
                    ...(sessionId ? { 'X-Aplus-Session-Id': sessionId } : {}),
                    ...(lifecycle ? { 'X-Aplus-Mcp-Lifecycle': lifecycle } : {}),
                },
                signal: ctl.signal,
            })
            if (!res.ok) {
                logger.debug(`[aplus] mcp-config 응답 ${res.status} — skip`)
                return snapshot({ ok: false, reason: 'http-error', error: `mcp-config responded with ${res.status}` })
            }
            const body = (await res.json()) as {
                mcpServers?: AplusMcpServersMap
                browserViewerRouting?: { required?: unknown; viewerKey?: unknown }
                connectorReadiness?: { expected?: unknown }
                mcpReadiness?: { expected?: unknown; configured?: unknown; missing?: unknown }
            }
            if (!body?.mcpServers || typeof body.mcpServers !== 'object') {
                logger.debug('[aplus] mcp-config 응답에 mcpServers 없음 — skip')
                return snapshot({ ok: false, reason: 'invalid-response', error: 'mcp-config response is invalid' })
            }
            const keys = Object.keys(body.mcpServers)
            if (body.browserViewerRouting?.required === true) {
                process.env.HAPPY_BROWSER_VIEWER_SCOPE_REQUIRED = '1'
                const viewerKey = body.browserViewerRouting.viewerKey
                if (typeof viewerKey === 'string' && /^bv1_[A-Za-z0-9_-]{32}$/.test(viewerKey)) {
                    process.env.HAPPY_BROWSER_VIEWER_KEY = viewerKey
                } else {
                    delete process.env.HAPPY_BROWSER_VIEWER_KEY
                }
            } else {
                delete process.env.HAPPY_BROWSER_VIEWER_SCOPE_REQUIRED
                delete process.env.HAPPY_BROWSER_VIEWER_KEY
            }
            const authoritativeExpected = connectorNames(body.connectorReadiness?.expected)
            if (authoritativeExpected) {
                process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = JSON.stringify(authoritativeExpected)
            }
            const authoritativeMcpExpected = connectorNames(body.mcpReadiness?.expected)
            const authoritativeMcpConfigured = connectorNames(body.mcpReadiness?.configured)
            const authoritativeMcpMissing = missingMcpServices(body.mcpReadiness?.missing)
            if (authoritativeMcpExpected) {
                process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES = JSON.stringify(authoritativeMcpExpected)
            }
            if (
                authoritativeMcpExpected
                && authoritativeMcpConfigured
                && authoritativeMcpMissing
                && authoritativeMcpMissing.length > 0
            ) {
                const missingNames = authoritativeMcpMissing.map(({ name }) => name)
                logger.debug(
                    `[aplus] MCP topology mismatch expected=${authoritativeMcpExpected.join(',')}`
                    + ` configured=${authoritativeMcpConfigured.join(',') || '(none)'}`
                    + ` missing=${missingNames.join(',')} attempt=${attempt + 1}`,
                )
                if (attempt === 0) continue
                return snapshot({
                    ok: false,
                    reason: 'mcp-config-missing',
                    error: `Expected MCP service configuration is missing: ${missingNames.join(', ')}`,
                    expected: authoritativeMcpExpected,
                    configured: authoritativeMcpConfigured,
                    missing: authoritativeMcpMissing,
                }, body.mcpServers)
            }
            const currentExpected = authoritativeExpected ?? expected
            const configured = currentExpected.filter((provider) => keys.includes(provider))
            const missing = currentExpected.filter((provider) => !configured.includes(provider))
            if (missing.length > 0) {
                logger.debug(
                    `[aplus] connector topology mismatch expected=${currentExpected.join(',')}`
                    + ` configured=${configured.join(',') || '(none)'}`
                    + ` missing=${missing.join(',')} attempt=${attempt + 1}`,
                )
                if (attempt === 0) continue
                return snapshot({
                    ok: false,
                    reason: 'connector-config-missing',
                    error: `Expected connector configuration is missing: ${missing.join(', ')}`,
                    expected: currentExpected,
                    configured,
                    missing,
                }, body.mcpServers)
            }
            logger.debug(`[aplus] mcp-config 받음 — 등록: ${keys.join(', ')}`)
            return snapshot({ ok: true, servers: body.mcpServers }, body.mcpServers)
        } catch {
            const timedOut = ctl.signal.aborted
            logger.debug(`[aplus] mcp-config fetch 실패 — skip: ${timedOut ? 'timeout' : 'network error'}`)
            return snapshot(timedOut
                ? { ok: false, reason: 'timeout', error: 'mcp-config request timed out' }
                : { ok: false, reason: 'network-error', error: 'mcp-config network request failed' })
        } finally {
            clearTimeout(timer)
        }
    }
    return snapshot({ ok: false, reason: 'invalid-response', error: 'mcp-config response is invalid' })
}

export async function fetchAplusMcpServersResult(
    token: string,
    machineId: string,
    context: McpFetchContext = {},
): Promise<AplusMcpServersFetchResult> {
    return (await fetchAplusMcpConfigSnapshot(token, machineId, context)).result
}

export async function fetchAplusMcpServers(token: string, machineId: string): Promise<AplusMcpServersMap> {
    return (await fetchAplusMcpConfigSnapshot(token, machineId)).servers
}
