import { describe, expect, it, vi } from 'vitest'
import { createOrgLlmEndpointStudioClient } from './orgLlmEndpointStudio'

// aplus specs/org-llm-endpoints r2 — the daemon tells Studio a session started and asks before a resume.

const ORIGIN = 'https://studio.example.test'
const BEARER = 'daemon-happy-token-SECRET'
const started = { bindingId: 'binding-1', sessionId: 'session-1', targetId: 'target-a' }
const resume = { bindingId: 'binding-1', sessionId: 'session-1', endpointId: 'endpoint-1', targetId: 'target-a', generation: 3 }

function setup(responses: Array<number | Error | (() => Response)>, options: { studioOrigin?: string | null } = {}) {
  const queue = [...responses]
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = queue.shift() ?? 200
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next() : new Response(next === 204 ? null : '{}', { status: next })
  })
  const warn = vi.fn()
  const sleep = vi.fn(async (_ms: number) => undefined)
  const client = createOrgLlmEndpointStudioClient({
    studioOrigin: options.studioOrigin === undefined ? ORIGIN : options.studioOrigin,
    bearer: () => BEARER, fetch, warn, sleep,
  })
  return { client, fetch, warn, sleep }
}

describe('session-started report', () => {
  it('posts the binding, session and target with the daemon token, never following a redirect', async () => {
    const { client, fetch } = setup([200])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${ORIGIN}/api/org-llm-endpoints/daemon/session-started`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' } })
    expect(JSON.parse(init.body as string)).toEqual(started)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('retries a failure that may be temporary a few times and then reports success', async () => {
    const { client, fetch, sleep } = setup([new TypeError('fetch failed'), 503, 200])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('does not retry a refusal', async () => {
    const { client, fetch, warn } = setup([409])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: false })
    expect(fetch).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('never throws, gives up after a bounded number of attempts and logs no secret or address', async () => {
    const { client, fetch, warn } = setup([new Error(`connect ECONNREFUSED ${ORIGIN} ${BEARER}`), 500, 502, 503, 504])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: false })
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('session-started')
    expect(logged).not.toContain(BEARER)
    expect(logged).not.toContain('studio.example')
  })

  it('does nothing, and says so, without a trusted Studio address', async () => {
    const { client, fetch, warn } = setup([200], { studioOrigin: null })
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reads at most a small part of the answer and then lets go', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024)) }, cancel })
    const { client } = setup([() => new Response(body, { status: 200 })])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: true })
    expect(cancel).toHaveBeenCalled()
  })
})

describe('resume check', () => {
  it('posts the recorded binding and lets the resume go on a 200', async () => {
    const { client, fetch } = setup([200])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: true })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${ORIGIN}/api/org-llm-endpoints/daemon/resume-check`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${BEARER}` } })
    expect(JSON.parse(init.body as string)).toEqual(resume)
  })

  it.each([400, 401, 403, 404, 409, 204, 201])('refuses on status %s without asking again', async (status) => {
    const { client, fetch } = setup([status])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: false, reason: 'REFUSED' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('refuses when Studio cannot be reached, after one more try', async () => {
    const { client, fetch } = setup([new TypeError('fetch failed'), new TypeError('fetch failed')])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: false, reason: 'UNREACHABLE' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('tries again after a server error and accepts the second answer', async () => {
    const { client } = setup([503, 200])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: true })
  })

  it('refuses when a persistent server error is all it hears', async () => {
    const { client } = setup([500, 502])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: false, reason: 'UNREACHABLE' })
  })

  it('refuses without a trusted Studio address instead of resuming unchecked', async () => {
    const { client, fetch } = setup([200], { studioOrigin: null })
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: false, reason: 'STUDIO_UNCONFIGURED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('logs nothing that carries the token', async () => {
    const { client, warn } = setup([new Error(`boom ${BEARER}`), new Error(`boom ${BEARER}`)])
    await client.checkResume(resume)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(BEARER)
  })
})
