import { describe, expect, it, vi } from 'vitest'
import { startDaemonControlServer } from './controlServer'
import type { SetupTokenAccountSwitch } from './setupTokenAccountSwitch'

const observation = { observedAt: 10, reason: 'ok', retryAt: null, windows: [{ kind: 'unified5h', pct: 96, resetsAt: 20 }] }

async function control(switcher: SetupTokenAccountSwitch | null) {
  return startDaemonControlServer({
    getSetupTokenAccountSwitch: () => switcher,
    getChildren: () => [], stopSession: () => ({ status: 'not-found' } as any),
    spawnSession: async () => ({ type: 'error', errorMessage: 'unused' } as any), requestShutdown: () => {}, onHappySessionWebhook: () => {},
    portRegistry: { allocate: async () => ({ port: 30000, reused: false }), release: async () => false, readAll: async () => ({}) },
  })
}

describe('setup-token control routes (specs/claude-setup-token-account-selection)', () => {
  it('forwards a session usage report and a switch request, authenticated by the control secret', async () => {
    const switcher = {
      reportUsage: vi.fn(async () => ({ ok: true as const })),
      rebind: vi.fn(async () => ({ ok: true as const, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' } })),
    }
    const server = await control(switcher)
    const post = (path: string, body: unknown, authenticated = true) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${server.controlSecret}` } : {}) }, body: JSON.stringify(body) })
    try {
      expect((await post('/setup-token/rebind', { sessionId: 'session-a', binding: '{}' }, false)).status).toBe(401)
      expect(switcher.rebind).not.toHaveBeenCalled()
      expect(await (await post('/setup-token/usage', { sessionId: 'session-a', binding: '{}', observation })).json()).toEqual({ ok: true })
      expect(switcher.reportUsage).toHaveBeenCalledWith('session-a', '{}', observation)
      expect(await (await post('/setup-token/rebind', { sessionId: 'session-a', binding: '{}' })).json()).toEqual({ ok: true, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' } })
      expect((await post('/setup-token/usage', { sessionId: 'session-a', binding: '{}', observation: { ...observation, windows: [{ kind: 'unified5h', pct: 101, resetsAt: 20 }] } })).status).toBe(400)
    } finally { await server.stop() }
  })

  it('answers unavailable when this daemon cannot switch accounts', async () => {
    const server = await control(null)
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/setup-token/rebind`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.controlSecret}` }, body: JSON.stringify({ sessionId: 'session-a', binding: '{}' }) })
      expect(await response.json()).toEqual({ ok: false, reason: 'STUDIO_UNAVAILABLE' })
    } finally { await server.stop() }
  })
})
