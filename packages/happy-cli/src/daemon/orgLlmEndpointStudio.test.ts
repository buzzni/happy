import { describe, expect, it, vi } from 'vitest'
import { createOrgLlmEndpointStudioClient } from './orgLlmEndpointStudio'

// aplus specs/org-llm-endpoints r2 — the daemon tells Studio a session started and asks before a resume.

const ORIGIN = 'https://studio.example.test'
const BEARER = 'daemon-happy-token-SECRET'
const started = { bindingId: 'binding-1', sessionId: 'session-1', targetId: 'target-a' }
const resume = { bindingId: 'binding-1', sessionId: 'session-1', endpointId: 'endpoint-1', targetId: 'target-a', generation: 3 }

const startedBody = { ok: true, bindingId: 'binding-1', status: 'started' }

// A bare status gets the body Studio sends for it: the success body of the call under test for a 200, an error body otherwise.
function setup(responses: Array<number | Error | (() => Response)>, options: { studioOrigin?: string | null; okBody?: unknown } = {}) {
  const queue = [...responses]
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = queue.shift() ?? 200
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next()
    if (next === 204) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(next >= 200 && next < 300 ? options.okBody ?? {} : { error: 'x' }), { status: next })
  })
  const warn = vi.fn()
  const sleep = vi.fn(async (_ms: number) => undefined)
  const client = createOrgLlmEndpointStudioClient({
    studioOrigin: options.studioOrigin === undefined ? ORIGIN : options.studioOrigin,
    bearer: () => BEARER, fetch, warn, sleep,
  })
  return { client, fetch, warn, sleep }
}
const json = (body: unknown, status = 200) => () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

describe('session-started report', () => {
  it('posts the binding, session and target with the daemon token, never following a redirect', async () => {
    const { client, fetch } = setup([200], { okBody: startedBody })
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${ORIGIN}/api/org-llm-endpoints/daemon/session-started`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' } })
    expect(JSON.parse(init.body as string)).toEqual(started)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('retries a failure that may be temporary a few times and then reports success', async () => {
    const { client, fetch, sleep } = setup([new TypeError('fetch failed'), 503, 200], { okBody: startedBody })
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
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: false })
    expect(cancel).toHaveBeenCalled()
  })
})

describe('session-started answers', () => {
  it.each([
    ['an HTML page a proxy served with a 200', json('<html><body>ok</body></html>')],
    ['an empty body', json('')],
    ['a body that is not an object', json('[1]')],
    ['ok without the binding id', json({ ok: true, status: 'started' })],
    ['another binding id', json({ ok: true, bindingId: 'binding-2', status: 'started' })],
    ['another status', json({ ok: true, bindingId: 'binding-1', status: 'prepared' })],
    ['ok false', json({ ok: false, bindingId: 'binding-1', status: 'started' })],
    ['a truthy ok that is not true', json({ ok: 'yes', bindingId: 'binding-1', status: 'started' })],
    ['a 204', () => new Response(null, { status: 204 })],
  ])('does not count %s as reported, and does not ask again', async (_label, answer) => {
    const { client, fetch, warn } = setup([answer])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: false })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('<html>')
  })

  it('counts exactly the body Studio documents', async () => {
    const { client } = setup([json({ ok: true, bindingId: 'binding-1', status: 'started', extra: 'ignored' })])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: true })
  })

  it('does not read an answer larger than its limit, however well it starts', async () => {
    const huge = `{"ok":true,"bindingId":"binding-1","status":"started","pad":"${'x'.repeat(64 * 1024)}"}`
    const { client } = setup([json(huge)])
    await expect(client.reportSessionStarted(started)).resolves.toEqual({ ok: false })
  })
})

describe('resume check', () => {
  it('posts the recorded binding and lets the resume go on a 200', async () => {
    const { client, fetch } = setup([200], { okBody: { ok: true } })
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: true })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${ORIGIN}/api/org-llm-endpoints/daemon/resume-check`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${BEARER}` } })
    expect(JSON.parse(init.body as string)).toEqual(resume)
  })

  it.each([400, 401, 403, 404, 409, 204])('refuses on status %s without asking again', async (status) => {
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
    const { client } = setup([503, 200], { okBody: { ok: true } })
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

describe('resume check answers', () => {
  it.each([
    ['an HTML page a proxy served with a 200', json('<html><body>ok</body></html>')],
    ['an empty body', json('')],
    ['an empty object', json({})],
    ['ok false', json({ ok: false })],
    ['a truthy ok that is not true', json({ ok: 1 })],
    ['a string true', json({ ok: 'true' })],
    ['a body that is not an object', json('true')],
    ['a created status carrying the right body', () => new Response(JSON.stringify({ ok: true }), { status: 201 })],
  ])('refuses %s without asking again', async (_label, answer) => {
    const { client, fetch, warn } = setup([answer])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: false, reason: 'REFUSED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('<html>')
  })

  it('lets a resume go only on exactly an ok true answer', async () => {
    const { client } = setup([json({ ok: true, note: 'extra fields are ignored' })])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: true })
  })

  it('refuses an answer larger than its limit even when it begins with ok true', async () => {
    const { client } = setup([json(`{"ok":true,"pad":"${'x'.repeat(64 * 1024)}"}`)])
    await expect(client.checkResume(resume)).resolves.toEqual({ ok: false, reason: 'REFUSED' })
  })
})
