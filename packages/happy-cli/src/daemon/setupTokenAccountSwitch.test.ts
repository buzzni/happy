import { describe, expect, it, vi } from 'vitest'
import { createSetupTokenAccountSwitch, type SetupTokenAccountSwitchDeps } from './setupTokenAccountSwitch'
import { formatSetupTokenBinding, SETUP_TOKEN_BINDING_ENV, type AiAuthSelection, type SetupTokenBinding } from './sessionEnv'
import type { TrackedSession } from './types'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const NONCE_A = '00000000-0000-4000-8000-0000000000aa'
const NONCE_B = '00000000-0000-4000-8000-0000000000bb'
// B was issued after A: a switch from A to B.
const binding = (managedAccountId: string, userId = 'user-a', nonce = managedAccountId === A ? NONCE_A : NONCE_B): SetupTokenBinding => ({
  managedAccountId, credentialGeneration: 1, groupScope: 'org-a', companyId: 'org-a', userId, machineId: 'pc-a',
  keyId: 'f'.repeat(64), nonce, issuedAt: managedAccountId === A ? 1 : 2,
})
const RUNNING_A = formatSetupTokenBinding(binding(A))
const observation = { observedAt: 10, reason: 'ok' as const, retryAt: null, windows: [{ kind: 'unified5h' as const, pct: 96, resetsAt: 20 }] }

function setup(extra: Partial<SetupTokenAccountSwitchDeps> = {}) {
  const session = { happySessionId: 'session-a', agentEnvironment: { [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(A)) } } as unknown as TrackedSession
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = []
  const deps: SetupTokenAccountSwitchDeps = {
    findSession: (id) => id === 'session-a' ? session : undefined,
    studioOrigin: 'https://studio.test',
    machineId: 'pc-a',
    bearer: () => 'machine-token',
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') })
      return Response.json(String(url).endsWith('/rebind')
        ? { version: 1, bindingGrant: 'claims.signature', managedAccountId: B, credentialGeneration: 1, tier: 'available' }
        : { version: 1, recorded: true })
    }) as unknown as typeof fetch,
    sessionEnvironment: vi.fn(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', HAPPY_AI_AUTH_SOURCE: 'org-bundle', [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) })),
    recordAgentEnvironment: vi.fn(),
    ...extra,
  }
  return { session, requests, deps, switcher: createSetupTokenAccountSwitch(deps) }
}

describe('setup-token account switch (specs/claude-setup-token-account-selection)', () => {
  it("reports a session's usage for the account it is bound to", async () => {
    const { switcher, requests } = setup()
    expect(await switcher.reportUsage('session-a', RUNNING_A, observation)).toEqual({ ok: true })
    expect(requests).toEqual([{ url: 'https://studio.test/api/claude-setup-token/daemon/usage', authorization: 'Bearer machine-token',
      body: { machineId: 'pc-a', sessionId: 'session-a', companyId: 'org-a', bindingNonce: NONCE_A, observation } }])
  })

  it('moves a bound session to the account Studio chose, through the same grant verification as a launch', async () => {
    const { switcher, requests, deps, session } = setup()
    const result = await switcher.rebind('session-a', RUNNING_A)
    expect(requests[0]).toEqual({ url: 'https://studio.test/api/claude-setup-token/daemon/rebind', authorization: 'Bearer machine-token',
      body: { machineId: 'pc-a', sessionId: 'session-a', companyId: 'org-a', bindingNonce: NONCE_A } })
    expect(deps.sessionEnvironment).toHaveBeenCalledWith('claude', { kind: 'claude-setup-token', managedAccountId: B, groupScope: 'org-a', credentialGeneration: 1, bindingGrant: 'claims.signature' })
    expect(result).toEqual({ ok: true, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', HAPPY_AI_AUTH_SOURCE: 'org-bundle', [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) } })
    expect(deps.recordAgentEnvironment).toHaveBeenCalledWith(session, formatSetupTokenBinding(binding(B)))
  })

  it('stays on the current account when Studio has no better one', async () => {
    const { switcher, deps } = setup({ fetch: vi.fn(async () => Response.json({ error: 'SETUP_TOKEN_DAEMON_NO_ACCOUNT' }, { status: 409 })) as unknown as typeof fetch })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'NO_ACCOUNT' })
    expect(deps.sessionEnvironment).not.toHaveBeenCalled()
  })

  it('refuses a grant that would hand the session to another member', async () => {
    const { switcher, deps } = setup({ sessionEnvironment: vi.fn(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B, 'user-b')) })) })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'BINDING_REJECTED' })
    expect(deps.recordAgentEnvironment).not.toHaveBeenCalled()
  })

  it('refuses when the grant fails verification', async () => {
    const { switcher, deps } = setup({ sessionEnvironment: vi.fn(async () => { throw new Error('CLAUDE_SETUP_TOKEN_BINDING_EXPIRED') }) })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'BINDING_REJECTED' })
    expect(deps.recordAgentEnvironment).not.toHaveBeenCalled()
  })

  it('does nothing for a session without a setup-token binding or without a trusted Studio origin', async () => {
    const unbound = setup({ findSession: () => ({ happySessionId: 'session-a' }) as TrackedSession })
    expect(await unbound.switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(await unbound.switcher.reportUsage('session-a', RUNNING_A, observation)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    const noOrigin = setup({ studioOrigin: null })
    expect(await noOrigin.switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'STUDIO_UNAVAILABLE' })
    expect(noOrigin.requests).toEqual([])
  })

  it('brings a session that missed a finished switch onto the account the daemon recorded, without asking Studio again', async () => {
    const { switcher, requests, deps, session } = setup()
    session.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) }
    expect(await switcher.rebind('session-a', RUNNING_A)).toMatchObject({ ok: true })
    expect(requests).toEqual([])
    expect(deps.sessionEnvironment).toHaveBeenCalledWith('claude', { kind: 'claude-setup-token', managedAccountId: B, groupScope: 'org-a', credentialGeneration: 1 }, binding(B))
    expect(deps.recordAgentEnvironment).not.toHaveBeenCalled()
  })

  it('drops usage a session observed on an account the daemon no longer records for it', async () => {
    const { switcher, requests, session } = setup()
    session.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) }
    expect(await switcher.reportUsage('session-a', RUNNING_A, observation)).toEqual({ ok: false, reason: 'STALE' })
    expect(requests).toEqual([])
  })

  it('runs one switch per session at a time', async () => {
    let release!: () => void
    const { switcher, deps } = setup({ sessionEnvironment: vi.fn(() => new Promise<Record<string, string>>(resolve => { release = () => resolve({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) }) })) })
    const first = switcher.rebind('session-a', RUNNING_A)
    const second = switcher.rebind('session-a', RUNNING_A)
    await vi.waitFor(() => expect(deps.sessionEnvironment).toHaveBeenCalledTimes(1))
    release()
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: true })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
  })

  it('never moves a session back to an older binding the daemon still records', async () => {
    const { switcher, requests, deps, session } = setup()
    // The daemon lost the switch to B (its write failed, then it restarted); the session runs B.
    expect(await switcher.rebind('session-a', formatSetupTokenBinding(binding(B)))).toEqual({ ok: false, reason: 'STALE' })
    expect(requests).toEqual([])
    expect(deps.sessionEnvironment).not.toHaveBeenCalled()
    expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(RUNNING_A)
  })

  it('asks Studio when the binding a session missed can no longer be used', async () => {
    const { switcher, requests, deps, session } = setup()
    session.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) }
    vi.mocked(deps.sessionEnvironment).mockRejectedValueOnce(new Error('CLAUDE_SETUP_TOKEN_BINDING_STALE'))
    expect(await switcher.rebind('session-a', RUNNING_A)).toMatchObject({ ok: true })
    expect(requests.map(request => [request.url.split('/').pop(), request.body.bindingNonce])).toEqual([['rebind', NONCE_B]])
  })

  it('tells the session when Studio refuses this binding for good', async () => {
    const forbidden = vi.fn(async () => Response.json({ error: 'SETUP_TOKEN_DAEMON_BINDING_FORBIDDEN' }, { status: 403 })) as unknown as typeof fetch
    const { switcher } = setup({ fetch: forbidden })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'FORBIDDEN' })
    expect(await switcher.reportUsage('session-a', RUNNING_A, observation)).toEqual({ ok: false, reason: 'FORBIDDEN' })
  })

  it('finishes a switch whose answer the session never received, from the binding it recorded', async () => {
    // Like the runtime: a launch needs a fresh grant unless it resumes a recorded binding.
    const sessionEnvironment = vi.fn(async (_agent: string, selection: AiAuthSelection, recorded?: SetupTokenBinding) => {
      if (!('bindingGrant' in selection && selection.bindingGrant) && !recorded) throw new Error('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      const bound = recorded ?? binding(B)
      return { CLAUDE_CODE_OAUTH_TOKEN: `token-${bound.managedAccountId}`, [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(bound) }
    })
    const { switcher, requests, session } = setup({
      sessionEnvironment,
      recordAgentEnvironment: (tracked, value) => { tracked.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: value } },
    })
    expect(await switcher.rebind('session-a', RUNNING_A)).toMatchObject({ ok: true })
    expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(formatSetupTokenBinding(binding(B)))
    // The session's request timed out: it still runs A and asks again.
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: true, environment: {
      CLAUDE_CODE_OAUTH_TOKEN: `token-${B}`, [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) } })
    expect(requests.filter(request => request.url.endsWith('/rebind'))).toHaveLength(1)
  })
})
