import { describe, expect, it, vi } from 'vitest'
import { startDaemonControlServer } from './controlServer'
import type { SetupTokenAccountSwitch } from './setupTokenAccountSwitch'

const observation = { observedAt: 10, reason: 'ok', retryAt: null, windows: [{ kind: 'unified5h', pct: 96, resetsAt: 20 }] }

async function control(switcher: Pick<SetupTokenAccountSwitch, 'availability' | 'returnFromPersonal' | 'reportUsage' | 'reportActivity' | 'rebind'> & Partial<Pick<SetupTokenAccountSwitch, 'requestStart'>> | null) {
  return startDaemonControlServer({
    getSetupTokenAccountSwitch: () => switcher,
    getChildren: () => [], stopSession: () => ({ status: 'not-found' } as any),
    spawnSession: async () => ({ type: 'error', errorMessage: 'unused' } as any), requestShutdown: () => {}, onHappySessionWebhook: () => {},
    portRegistry: { allocate: async () => ({ port: 30000, reused: false }), release: async () => false, readAll: async () => ({}) },
  })
}

describe('setup-token control routes (specs/claude-setup-token-account-selection)', () => {
  it('forwards a session usage report and a switch request, authenticated by the control secret', async () => {
    const switcher = { availability: vi.fn(async () => ({ ok: true as const, allLimited: true, availableAccountIds: [], consentApproved: true })), returnFromPersonal: vi.fn(async () => ({ ok: true as const, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-org' } })),
      requestStart: vi.fn(async () => ({ok:true as const, admission:{state:'allowed' as const,validForMs:15000}})),
      reportActivity: vi.fn(async () => ({ok:true as const})), reportUsage: vi.fn(async () => ({ ok: true as const })),
      rebind: vi.fn(async () => ({ ok: true as const, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' } })),
    }
    const server = await control(switcher)
    const post = (path: string, body: unknown, authenticated = true) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${server.controlSecret}` } : {}) }, body: JSON.stringify(body) })
    try {
      expect((await post('/setup-token/rebind', { sessionId: 'session-a', binding: '{}' }, false)).status).toBe(401)
      expect(switcher.rebind).not.toHaveBeenCalled()
      const start={sessionId:'session-a',binding:'{}',requestId:'00000000-0000-4000-8000-000000000001'}
      expect((await post('/setup-token/start',start,false)).status).toBe(401)
      expect(switcher.requestStart).not.toHaveBeenCalled()
      expect((await post('/setup-token/start',{...start,requestId:'invalid'})).status).toBe(400)
      expect(switcher.requestStart).not.toHaveBeenCalled()
      expect(await (await post('/setup-token/start',start)).json()).toEqual({ok:true,admission:{state:'allowed',validForMs:15000}})
      expect(switcher.requestStart).toHaveBeenCalledWith('session-a','{}',start.requestId,expect.any(AbortSignal))

      expect(await (await post('/setup-token/usage', { sessionId: 'session-a', binding: '{}', observation })).json()).toEqual({ ok: true })
      expect(switcher.reportUsage).toHaveBeenCalledWith('session-a', '{}', observation, expect.any(AbortSignal))
      const activity = {instanceId:'i',turnId:'t',seq:1,state:'active'}
      expect((await post('/setup-token/usage', {sessionId:'session-a',binding:'{}',activity}, false)).status).toBe(401)
      expect(switcher.reportActivity).not.toHaveBeenCalled()
      expect(await (await post('/setup-token/usage', {sessionId:'session-a',binding:'{}',activity})).json()).toEqual({ok:true})
      expect(switcher.reportActivity).toHaveBeenCalledWith('session-a','{}',activity,expect.any(AbortSignal))
      expect((await post('/setup-token/usage', {sessionId:'session-a',binding:'{}',activity,observation})).status).toBe(400)
      const organizationFailure={kind:'authentication',observedAt:1000}
      const personalConsent={proof:'fixture-proof',accountRef:'a'.repeat(64),nonce:'b'.repeat(48)}
      expect((await post('/setup-token/availability',{sessionId:'session-a',binding:'{}',personalConsent,organizationFailure},false)).status).toBe(401)
      expect(await (await post('/setup-token/availability',{sessionId:'session-a',binding:'{}',personalConsent,organizationFailure})).json()).toMatchObject({ok:true,allLimited:true,consentApproved:true})
      expect(switcher.availability).toHaveBeenCalledWith('session-a','{}',personalConsent,organizationFailure)
      expect(await (await post('/setup-token/return',{sessionId:'session-a',binding:'{}',organizationFailure})).json()).toMatchObject({ok:true})
      expect(switcher.returnFromPersonal).toHaveBeenCalledWith('session-a','{}',organizationFailure)
      expect(await (await post('/setup-token/rebind', { sessionId: 'session-a', binding: '{}' })).json()).toEqual({ ok: true, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next' } })
      const finalRefusal = { observedAt: 10, reason: 'rate-limited', retryAt: null, windows: [] };
      expect((await post('/setup-token/rebind', { sessionId: 'session-a', binding: '{}', observation: finalRefusal })).status).toBe(200);
      expect(switcher.rebind).toHaveBeenLastCalledWith('session-a', '{}', finalRefusal, expect.any(AbortSignal));
      const authFailure = { ...finalRefusal, reason: 'authentication-failed' };
      expect((await post('/setup-token/rebind', { sessionId: 'session-a', binding: '{}', observation: authFailure })).status).toBe(200);
      expect(switcher.rebind).toHaveBeenLastCalledWith('session-a', '{}', authFailure, expect.any(AbortSignal));
      expect((await post('/setup-token/rebind', { sessionId: 'session-a', binding: '{}', observation: { ...authFailure, reason: 'ok' } })).status).toBe(400);

      expect((await post('/setup-token/usage', { sessionId: 'session-a', binding: '{}', observation: { ...observation, windows: [{ kind: 'unified5h', pct: 101, resetsAt: 20 }] } })).status).toBe(400)
    } finally { await server.stop() }
  })

  it('cancels a machine rebind when the launcher closes its stopped request', async () => {
    let cancelled = false;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve });
    const switcher = { availability: vi.fn(), returnFromPersonal: vi.fn(), reportActivity: vi.fn(async () => ({ok:true as const})), reportUsage: vi.fn(), rebind: vi.fn<SetupTokenAccountSwitch['rebind']>(async (_id, _binding, _observation, signal) => {
      started();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }));
      return { ok: false, reason: 'REQUEST_FAILED' };
    }) };
    const server = await control(switcher);
    const stop = new AbortController();
    try {
      const response = fetch(`http://127.0.0.1:${server.port}/setup-token/rebind`, { method: 'POST', signal: stop.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.controlSecret}` }, body: JSON.stringify({ sessionId: 'session', binding: '{}' }) }).catch(() => null);
      await ready; stop.abort(); await response;
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally { await server.stop() }
  });

  it('answers unavailable when this daemon cannot switch accounts', async () => {
    const server = await control(null)
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/setup-token/rebind`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.controlSecret}` }, body: JSON.stringify({ sessionId: 'session-a', binding: '{}' }) })
      expect(await response.json()).toEqual({ ok: false, reason: 'STUDIO_UNAVAILABLE' })
    } finally { await server.stop() }
  })
})
