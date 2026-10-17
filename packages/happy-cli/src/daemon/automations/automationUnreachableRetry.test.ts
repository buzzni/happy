import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  planUnreachableRetry,
  runLeaseExpiresAt,
  unreachableFetchFailure,
  unreachableRetryFailureCode,
  UNREACHABLE_RETRY_LEASE_MARGIN_MS,
  unreachableHttpStatus,
  UNREACHABLE_RETRY_DELAYS_MS,
} from './automationUnreachableRetry'
import { exchangeAutomationMcpCallerGrant } from './automationMcpCallerGrant'
import { fetchAutomationProjectEnvironment } from './automationProjectEnvironment'

const MINUTE = 60_000

/** 방금 닫은 포트 — 연결은 실제로 거절된다(ECONNREFUSED). */
async function closedPortUrl(): Promise<string> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return `http://127.0.0.1:${port}`
}

async function respondingUrl(status: number): Promise<{ url: string; close: () => void }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

async function fetchError(url: string, init?: RequestInit): Promise<unknown> {
  try {
    await fetch(url, init)
  } catch (error) {
    return error
  }
  throw new Error('fetch unexpectedly succeeded')
}

describe('unreachableFetchFailure', () => {
  it('names a refused connection', async () => {
    expect(unreachableFetchFailure(await fetchError(await closedPortUrl()))).toBe('ECONNREFUSED')
  })

  it('names a host that does not resolve', async () => {
    const code = unreachableFetchFailure(await fetchError('http://saycode-unreachable-retry.invalid/'))
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(code)
  })

  it('treats the caller deadline as no answer', async () => {
    expect(unreachableFetchFailure(await fetchError(await closedPortUrl(), {
      signal: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')),
    }))).toBe('TIMEOUT')
  })

  it('does not classify failures that reached the other side or never involved a network', () => {
    expect(unreachableFetchFailure(new SyntaxError('Unexpected token < in JSON'))).toBeNull()
    expect(unreachableFetchFailure(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBeNull()
    expect(unreachableFetchFailure(null)).toBeNull()
  })
})

describe('unreachableHttpStatus', () => {
  it('counts only gateway statuses that mean the service behind it was not reached', () => {
    expect([502, 503, 504].map(unreachableHttpStatus)).toEqual(['HTTP_502', 'HTTP_503', 'HTTP_504'])
    expect([400, 401, 403, 404, 409, 429, 500].map(unreachableHttpStatus)).toEqual(Array(7).fill(null))
  })
})

describe('planUnreachableRetry', () => {
  const farAway = 24 * 60 * MINUTE
  // 서버 run lease 5분(start·heartbeat 응답의 runLeaseExpiresAt)을 그대로 쓴다 — 실패 시각 0, lease 5분.
  const lease = 5 * MINUTE

  it('walks about 1, 2 and 4 minutes from the first failure, then stops', () => {
    expect(UNREACHABLE_RETRY_DELAYS_MS).toEqual([MINUTE, MINUTE, 2 * MINUTE])
    // heartbeat 가 lease 를 이어 주는 동안(행복 서버는 닿고 Studio 만 막힌 경우)은 1·2·4분.
    expect(planUnreachableRetry({ attempt: 0, now: 0, nextRegularRunAt: farAway, leaseExpiresAt: lease })).toBe(MINUTE)
    expect(planUnreachableRetry({ attempt: 1, now: MINUTE, nextRegularRunAt: farAway, leaseExpiresAt: MINUTE + lease })).toBe(2 * MINUTE)
    expect(planUnreachableRetry({ attempt: 2, now: 2 * MINUTE, nextRegularRunAt: farAway, leaseExpiresAt: 2 * MINUTE + lease })).toBe(4 * MINUTE)
    expect(planUnreachableRetry({ attempt: 3, now: 4 * MINUTE, nextRegularRunAt: farAway, leaseExpiresAt: 4 * MINUTE + lease })).toBeNull()
  })

  it('pulls the last retry inside the lease when heartbeats could not extend it', () => {
    // 마지막 재시도가 틱 지연(최대 1분)과 요청 시간을 더해도 lease 만료 전에 서버에 닿게 당긴다.
    expect(UNREACHABLE_RETRY_LEASE_MARGIN_MS).toBe(90_000)
    expect(planUnreachableRetry({ attempt: 2, now: 2 * MINUTE, nextRegularRunAt: farAway, leaseExpiresAt: lease }))
      .toBe(lease - UNREACHABLE_RETRY_LEASE_MARGIN_MS)
    expect(planUnreachableRetry({ attempt: 1, now: lease - UNREACHABLE_RETRY_LEASE_MARGIN_MS, nextRegularRunAt: farAway, leaseExpiresAt: lease }))
      .toBeNull()
  })

  it('does not retry without a lease deadline from the server', () => {
    expect(planUnreachableRetry({ attempt: 0, now: 0, nextRegularRunAt: farAway, leaseExpiresAt: null })).toBeNull()
  })

  it('leaves the retry to the regular run when it is due at or before the retry', () => {
    expect(planUnreachableRetry({ attempt: 0, now: 0, nextRegularRunAt: MINUTE, leaseExpiresAt: lease })).toBeNull()
    expect(planUnreachableRetry({ attempt: 0, now: 0, nextRegularRunAt: MINUTE + 1, leaseExpiresAt: lease })).toBe(MINUTE)
  })
})

describe('runLeaseExpiresAt', () => {
  it('reads the lease deadline the server sends with start and heartbeat', () => {
    expect(runLeaseExpiresAt({ runLeaseExpiresAt: 1_700_000_300_000 })).toBe(1_700_000_300_000)
    expect(runLeaseExpiresAt({ runLeaseExpiresAt: '2026-10-17T00:05:00.000Z' })).toBe(Date.parse('2026-10-17T00:05:00.000Z'))
    expect(runLeaseExpiresAt({})).toBeNull()
    expect(runLeaseExpiresAt(undefined)).toBeNull()
    expect(runLeaseExpiresAt({ runLeaseExpiresAt: 'soon' })).toBeNull()
  })
})

describe('unreachableRetryFailureCode', () => {
  it('names how many automatic retries ran before the failure was recorded', () => {
    expect(unreachableRetryFailureCode('GRANT_EXCHANGE_FAILED', 3)).toBe('GRANT_EXCHANGE_FAILED_AFTER_3_RETRIES')
    expect(unreachableRetryFailureCode('GRANT_EXCHANGE_FAILED', 0)).toBe('GRANT_EXCHANGE_FAILED')
    expect(unreachableRetryFailureCode(null, 2)).toBeNull()
    // 서버의 failureCode 규칙(^[A-Z][A-Z0-9_]{0,63}$)을 넘기면 원래 코드를 둔다.
    const long = `A${'B'.repeat(60)}`
    expect(unreachableRetryFailureCode(long, 1)).toBe(long)
  })
})

describe('pre-model calls mark connectivity failures', () => {
  afterEach(() => vi.unstubAllGlobals())
  const claim = { machineToken: 'machine-token', machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token' }

  it('marks a caller grant exchange that could not reach Studio', async () => {
    await expect(exchangeAutomationMcpCallerGrant({ ...claim, configUrl: await closedPortUrl() })).resolves.toEqual({
      ok: false, error: 'caller grant exchange failed', unreachable: 'ECONNREFUSED',
    })
  })

  it('marks a project environment request that could not reach Studio', async () => {
    await expect(fetchAutomationProjectEnvironment({ ...claim, configUrl: await closedPortUrl() })).resolves.toEqual({
      ok: false, error: 'project environment request failed', unreachable: 'ECONNREFUSED',
    })
  })

  it('marks a gateway that could not reach the service behind it, but not a refusal', async () => {
    const gateway = await respondingUrl(503)
    const refusal = await respondingUrl(400)
    try {
      await expect(exchangeAutomationMcpCallerGrant({ ...claim, configUrl: gateway.url }))
        .resolves.toMatchObject({ ok: false, unreachable: 'HTTP_503' })
      await expect(fetchAutomationProjectEnvironment({ ...claim, configUrl: gateway.url }))
        .resolves.toMatchObject({ ok: false, unreachable: 'HTTP_503' })
      expect(await exchangeAutomationMcpCallerGrant({ ...claim, configUrl: refusal.url }))
        .not.toHaveProperty('unreachable')
      expect(await fetchAutomationProjectEnvironment({ ...claim, configUrl: refusal.url }))
        .not.toHaveProperty('unreachable')
    } finally {
      gateway.close()
      refusal.close()
    }
  })

  it('does not mark a response it could not understand', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    expect(await exchangeAutomationMcpCallerGrant({ ...claim, configUrl: 'https://studio.test' }))
      .not.toHaveProperty('unreachable')
    expect(await fetchAutomationProjectEnvironment({ ...claim, configUrl: 'https://studio.test' }))
      .not.toHaveProperty('unreachable')
  })
})
