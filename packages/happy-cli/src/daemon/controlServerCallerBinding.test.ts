import { describe, expect, it, vi } from 'vitest'
import { startDaemonControlServer } from './controlServer'

const report = { sessionId: 'source', runtimeId: 'runtime', hostPid: 42, callerPublicKey: 'k'.repeat(43) }
async function control(issue: ((raw: unknown) => Promise<unknown>) | null, managedRuntime = false,
  current: (raw: unknown) => Promise<{ current: boolean }> = async () => ({ current: false })) {
  return startDaemonControlServer({
    getCallerLaunches: () => issue ? { issue, current } : null, managedRuntime,
    getChildren: () => [], stopSession: () => ({ status: 'not-found' } as any),
    spawnSession: async () => ({ type: 'error', errorMessage: 'unused' } as any), requestShutdown: () => {}, onHappySessionWebhook: () => {},
    portRegistry: { allocate: async () => ({ port: 30000, reused: false }), release: async () => false, readAll: async () => ({}) },
  })
}
async function post(server: { port: number; controlSecret: string }, body: unknown, authenticated = true, path = '/caller-binding') {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${server.controlSecret}` } : {}) }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

describe('owner-contact caller-binding control route (T1c-b2 H2)', () => {
  it('forwards an authenticated launch report to the daemon issuer', async () => {
    const issue = vi.fn(async () => ({ caller: { callerBindingId: 'b' }, trust: { issuer: 'i' } }))
    const server = await control(issue)
    try {
      expect((await post(server, report, false)).status).toBe(401)
      expect(issue).not.toHaveBeenCalled()
      expect(await post(server, report)).toEqual({ status: 200, body: { caller: { callerBindingId: 'b' }, trust: { issuer: 'i' } } })
      expect(issue).toHaveBeenCalledWith(report)
    } finally { await server.stop() }
  })
  it('refuses without detail when the issuer refuses or is absent', async () => {
    const refusing = await control(async () => { throw new Error('caller-already-bound /secret/path') })
    const absent = await control(null)
    try {
      expect(await post(refusing, report)).toEqual({ status: 403, body: { error: 'owner-contact-unavailable' } })
      expect(await post(absent, report)).toEqual({ status: 403, body: { error: 'owner-contact-unavailable' } })
    } finally { await refusing.stop(); await absent.stop() }
  })
  it('is closed on a managed runtime', async () => {
    const issue = vi.fn()
    const server = await control(issue, true)
    try {
      expect((await post(server, report)).status).toBe(403)
      expect(issue).not.toHaveBeenCalled()
    } finally { await server.stop() }
  })
  it('answers whether a binding is still current, and nothing else [H2-R-03]', async () => {
    const current = vi.fn(async (raw: unknown) => ({ current: (raw as { callerBindingId: string }).callerBindingId === 'live' }))
    const server = await control(async () => ({}), false, current)
    const absent = await control(null)
    const throwing = await control(async () => ({}), false, async () => { throw new Error('detail') })
    try {
      const body = { sessionId: 'source', callerBindingId: 'live' }
      expect((await post(server, body, false, '/caller-binding/current')).status).toBe(401)
      expect(await post(server, body, true, '/caller-binding/current')).toEqual({ status: 200, body: { current: true } })
      expect(await post(server, { ...body, callerBindingId: 'old' }, true, '/caller-binding/current')).toEqual({ status: 200, body: { current: false } })
      expect(await post(absent, body, true, '/caller-binding/current')).toEqual({ status: 200, body: { current: false } })
      expect(await post(throwing, body, true, '/caller-binding/current')).toEqual({ status: 200, body: { current: false } })
    } finally { await server.stop(); await absent.stop(); await throwing.stop() }
  })
})
