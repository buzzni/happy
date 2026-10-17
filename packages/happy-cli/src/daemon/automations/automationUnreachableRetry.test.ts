import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  planUnreachableRetry,
  unreachableFetchFailure,
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
  it('walks 5, 15 and 30 minutes from each failure, then stops', () => {
    const farAway = 24 * 60 * MINUTE
    expect(UNREACHABLE_RETRY_DELAYS_MS).toEqual([5 * MINUTE, 15 * MINUTE, 30 * MINUTE])
    expect(planUnreachableRetry({ attempt: 0, now: 0, nextRegularRunAt: farAway })).toBe(5 * MINUTE)
    expect(planUnreachableRetry({ attempt: 1, now: 5 * MINUTE, nextRegularRunAt: farAway })).toBe(20 * MINUTE)
    expect(planUnreachableRetry({ attempt: 2, now: 20 * MINUTE, nextRegularRunAt: farAway })).toBe(50 * MINUTE)
    expect(planUnreachableRetry({ attempt: 3, now: 50 * MINUTE, nextRegularRunAt: farAway })).toBeNull()
  })

  it('leaves the retry to the regular run when it is due at or before the retry', () => {
    expect(planUnreachableRetry({ attempt: 0, now: 0, nextRegularRunAt: 5 * MINUTE })).toBeNull()
    expect(planUnreachableRetry({ attempt: 0, now: 0, nextRegularRunAt: 5 * MINUTE + 1 })).toBe(5 * MINUTE)
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
