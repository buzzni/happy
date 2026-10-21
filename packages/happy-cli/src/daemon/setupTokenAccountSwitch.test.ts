import { describe, expect, it, vi } from 'vitest'
import { createSetupTokenAccountSwitch, type SetupTokenAccountSwitchDeps } from './setupTokenAccountSwitch'
import { formatSetupTokenBinding, SETUP_TOKEN_BINDING_ENV, type AiAuthSelection, type SetupTokenBinding, type UserSetupTokenBinding } from './sessionEnv'
import type { TrackedSession } from './types'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const NONCE_A = '00000000-0000-4000-8000-0000000000aa'
const NONCE_B = '00000000-0000-4000-8000-0000000000bb'
// B was issued after A: a switch from A to B.
const binding = (managedAccountId: string, userId = 'user-a', nonce = managedAccountId === A ? NONCE_A : NONCE_B): UserSetupTokenBinding => ({
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
    recordAgentEnvironment: vi.fn(() => ({ status: 'committed' as const })),
    ...extra,
  }
  return { session, requests, deps, switcher: createSetupTokenAccountSwitch(deps) }
}

describe('setup-token account switch (specs/claude-setup-token-account-selection)', () => {
  it('keeps token-value verification negotiated across an account switch and refuses a downgraded response', async () => {
    const { switcher, session, deps } = setup()
    const running = formatSetupTokenBinding({ ...binding(A), tokenProof: 'a'.repeat(64) })
    session.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: running }
    vi.mocked(deps.fetch).mockResolvedValueOnce(Response.json({ version: 1, bindingGrant: 'claims.signature', managedAccountId: B, credentialGeneration: 1, credentialProofVersion: 1 }))
    vi.mocked(deps.sessionEnvironment).mockResolvedValueOnce({ CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-next', [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding({ ...binding(B), tokenProof: 'b'.repeat(64) }) })
    expect(await switcher.rebind('session-a', running)).toHaveProperty('ok', true)
    expect(JSON.parse(String(vi.mocked(deps.fetch).mock.calls[0][1]?.body))).toHaveProperty('credentialProofVersion', 1)
    expect(deps.sessionEnvironment).toHaveBeenCalledWith('claude', expect.objectContaining({ credentialProofVersion: 1 }))
    const other = setup()
    other.session.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: running }
    expect(await other.switcher.rebind('session-a', running)).toEqual({ ok: false, reason: 'REQUEST_FAILED' })
    expect(other.deps.sessionEnvironment).not.toHaveBeenCalled()
  })
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

  it('treats a missing durable ACK as indeterminate and never returns a token', async () => {
    const { switcher, session } = setup({ recordAgentEnvironment: vi.fn(() => undefined) as unknown as SetupTokenAccountSwitchDeps['recordAgentEnvironment'] })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'PERSISTENCE_INDETERMINATE' })
    expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(RUNNING_A)
  })

  it('retries the same verified binding after a failed save instead of consuming another grant', async () => {
    const record = vi.fn().mockReturnValueOnce({ status: 'failed' }).mockReturnValue({ status: 'committed' })
    const { switcher, deps, session } = setup({ recordAgentEnvironment: record })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'PERSISTENCE_FAILED' })
    expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(RUNNING_A)
    expect(await switcher.rebind('session-a', RUNNING_A)).toMatchObject({ ok: true })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(deps.sessionEnvironment).toHaveBeenCalledTimes(2)
    expect(deps.sessionEnvironment).toHaveBeenLastCalledWith('claude', expect.objectContaining({ managedAccountId: B }), binding(B))
    expect(record).toHaveBeenCalledTimes(2)
  })

  it('does not replay a pending save over a changed committed binding', async () => {
    const record = vi.fn(() => ({ status: 'failed' as const }))
    const { switcher, deps, session } = setup({ recordAgentEnvironment: record })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'PERSISTENCE_FAILED' })
    session.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) }
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'STALE' })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('revalidates the pending account after a save failure and refuses a revoked assignment', async () => {
    const record = vi.fn().mockReturnValueOnce({ status: 'failed' }).mockReturnValue({ status: 'committed' })
    const { switcher, deps } = setup({ recordAgentEnvironment: record })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'PERSISTENCE_FAILED' })
    vi.mocked(deps.sessionEnvironment).mockRejectedValueOnce(new Error('assignment revoked'))
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'BINDING_REJECTED' })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('does not publish or return a token if the session ends during grant preparation', async () => {
    const { switcher, deps } = setup()
    vi.mocked(deps.sessionEnvironment).mockImplementationOnce(async () => {
      deps.findSession = () => undefined
      return { CLAUDE_CODE_OAUTH_TOKEN: 'next', [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) }
    })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(deps.recordAgentEnvironment).not.toHaveBeenCalled()
  })

  it('does not return a token after the session ends while awaiting a save ACK', async () => {
    let ack!: (result: { status: 'committed' }) => void
    const record = vi.fn(() => new Promise<{ status: 'committed' }>(resolve => { ack = resolve }))
    const { switcher, deps } = setup({ recordAgentEnvironment: record })
    const pending = switcher.rebind('session-a', RUNNING_A)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    deps.findSession = () => undefined
    ack({ status: 'committed' })
    expect(await pending).toEqual({ ok: false, reason: 'NOT_BOUND' })
  })

  it('does not retry an indeterminate save or issue more grants', async () => {
    const record = vi.fn(() => ({ status: 'indeterminate' as const }))
    const { switcher, deps, session } = setup({ recordAgentEnvironment: record })
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'PERSISTENCE_INDETERMINATE' })
    }
    expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(RUNNING_A)
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('treats a throwing recorder as indeterminate and never returns its token', async () => {
    const record = vi.fn(() => { throw new Error('unexpected recorder failure') })
    const { switcher, deps } = setup({ recordAgentEnvironment: record })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'PERSISTENCE_INDETERMINATE' })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'PERSISTENCE_INDETERMINATE' })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
  })

  it('awaits the durable ACK and shares it with concurrent requests', async () => {
    let ack!: (result: { status: 'committed' }) => void
    const record = vi.fn(() => new Promise<{ status: 'committed' }>(resolve => { ack = resolve }))
    const { switcher } = setup({ recordAgentEnvironment: record })
    let completed = false
    const first = switcher.rebind('session-a', RUNNING_A).then(result => { completed = true; return result })
    const second = switcher.rebind('session-a', RUNNING_A)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    expect(completed).toBe(false)
    ack({ status: 'committed' })
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: true })
  })

  it('stays on the current account when Studio has no better one', async () => {
    const { switcher, deps } = setup({ fetch: vi.fn(async () => Response.json({ error: 'SETUP_TOKEN_DAEMON_NO_ACCOUNT' }, { status: 409 })) as unknown as typeof fetch })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'NO_ACCOUNT' })
    expect(deps.sessionEnvironment).not.toHaveBeenCalled()
  })

  // Saycode specs/claude-setup-token-managed-sync R6/R7: Studio picks only accounts this PC applied; a newer assignment must land first.
  it('answers APPLY_REQUIRED when Studio has an account this PC has not applied yet', async () => {
    const { switcher, deps } = setup({ fetch: vi.fn(async () => Response.json({ error: 'SETUP_TOKEN_DAEMON_APPLY_REQUIRED' }, { status: 409 })) as unknown as typeof fetch })
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'APPLY_REQUIRED' })
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
      recordAgentEnvironment: (tracked, value) => { tracked.agentEnvironment = { [SETUP_TOKEN_BINDING_ENV]: value }; return { status: 'committed' } },
    })
    expect(await switcher.rebind('session-a', RUNNING_A)).toMatchObject({ ok: true })
    expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(formatSetupTokenBinding(binding(B)))
    // The session's request timed out: it still runs A and asks again.
    expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: true, environment: {
      CLAUDE_CODE_OAUTH_TOKEN: `token-${B}`, [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) } })
    expect(requests.filter(request => request.url.endsWith('/rebind'))).toHaveLength(1)
  })
})

// aplus specs/shared-machine-server-signing Phase 3c — one machine-rotation runtime per company, found by the binding's company.
describe('machine-rotation bindings', () => {
  const machine = {
    version: 2, type: 'claude-setup-token-binding', audience: 'saycode-daemon', principalType: 'machine', companyId: 'org-m', machineId: 'pc-a',
    groupScope: 'org-m', assignmentGeneration: 1, assignmentFingerprint: 'a'.repeat(64), managedAccountId: A, credentialGeneration: 1,
    approvalId: 'approval', deviceKeyId: 'd'.repeat(64), launchId: 'launch', bindingRevision: 1, previousNonce: null,
    nonce: Buffer.alloc(32, 1).toString('base64url'), issuedAt: 1, expiresAt: 2, keyId: 'f'.repeat(64),
    execution: { sessionId: 'session-a', initialNonce: Buffer.alloc(32, 1).toString('base64url'), issueOperationId: 'op', sessionOwnerAccountId: 'owner', machineOwnerAccountId: 'machine-owner' },
  } as unknown as SetupTokenBinding
  const running = formatSetupTokenBinding(machine)

  it('reports usage and switches through the runtime of the binding\'s company', async () => {
    const runtime = { reportUsage: vi.fn(async () => ({ ok: true as const })), rebind: vi.fn(async () => ({ NEXT: '1' })) }
    const machineRuntime = vi.fn(async () => runtime as never)
    const { switcher } = setup({ machineRuntime })
    await expect(switcher.reportUsage('session-a', running, observation)).resolves.toEqual({ ok: true })
    await expect(switcher.rebind('session-a', running, observation)).resolves.toEqual({ ok: true, environment: { NEXT: '1' } })
    expect(machineRuntime.mock.calls).toEqual([['org-m'], ['org-m']])
  })

  it('reports Studio unavailable when that company has no runtime', async () => {
    const { switcher } = setup({ machineRuntime: async () => null })
    await expect(switcher.reportUsage('session-a', running, observation)).resolves.toMatchObject({ ok: false, reason: 'STUDIO_UNAVAILABLE' })
    await expect(switcher.rebind('session-a', running, observation)).resolves.toMatchObject({ ok: false, reason: 'STUDIO_UNAVAILABLE' })
  })
})
