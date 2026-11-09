import { logger } from '@/ui/logger'
import { describe, expect, it, vi } from 'vitest'
import { createSetupTokenAccountSwitch, type SetupTokenAccountSwitchDeps } from './setupTokenAccountSwitch'
import { formatSetupTokenBinding, SETUP_TOKEN_BINDING_ENV, SETUP_TOKEN_SHARED_ACCOUNT_ENV, sharedMachineSetupTokenAuthority, type AiAuthSelection, type SetupTokenBinding, type UserSetupTokenBinding } from './sessionEnv'
import type { TrackedSession } from './types'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
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
  it('moves only to the capacity reservation, retaining its execution identity across rebind', async () => {
    const { switcher, deps, requests } = setup()
    vi.mocked(deps.fetch).mockImplementationOnce(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') })
      return Response.json({ state: 'reserved', managedAccountId: B, credentialGeneration: 1, epoch: 1, validForMs: 15000, executionRequestId: 'execution-r' })
    })
    const actor = { companyId: 'org-a', machineId: 'pc-a', sessionId: 'session-a', requestId: 'input-r', contentHash: 'a'.repeat(64), proof: 'signed.proof' }
    expect(await switcher.capacity('session-a', RUNNING_A, 'reserve', actor, 'runtime', { companyId: 'forged', runtimeId: 'forged' })).toMatchObject({ ok: true, admission: { requiresMove: true } })
    expect(requests[0]).toMatchObject({ url: 'https://studio.test/api/claude-setup-token/capacity/reserve', body: { companyId: 'org-a', runtimeId: 'runtime', actorProof: actor.proof, requestId: 'input-r', excludeManagedAccountIds: [] } })
    expect(await switcher.rebind('session-a', RUNNING_A, undefined, undefined, { startBudget: true })).toHaveProperty('ok', true)
    expect(requests[1].body).toMatchObject({ startBudget: true, capacityRequestId: 'execution-r' })
  })
  it('refuses a disabled or stale local credential before a capacity claim', async () => {
    const { switcher, deps } = setup({ disabledSetupTokenAccounts: async () => [A] })
    const actor = { companyId: 'org-a', machineId: 'pc-a', sessionId: 'session-a', requestId: 'input-r', contentHash: 'a'.repeat(64), proof: 'signed.proof' }
    expect(await switcher.capacity('session-a', RUNNING_A, 'claim', actor, 'runtime', { managedAccountId: A, credentialGeneration: 1, epoch: 1 })).toEqual({ ok: false, reason: 'CAPACITY_BINDING_FORBIDDEN' })
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(await switcher.capacity('session-a', RUNNING_A, 'reserve', { ...actor, machineId: 'other' }, 'runtime')).toEqual({ ok: false, reason: 'CAPACITY_ACTOR_FORBIDDEN' })
    expect(deps.fetch).not.toHaveBeenCalled()
  })
  it('passes the capacity handler code through but names any other Studio refusal by its HTTP status', async () => {
    const { switcher, deps } = setup()
    const actor = { companyId: 'org-a', machineId: 'pc-a', sessionId: 'session-a', requestId: 'input-r', contentHash: 'a'.repeat(64), proof: 'signed.proof' }
    vi.mocked(deps.fetch).mockResolvedValueOnce(Response.json({ error: 'CAPACITY_SESSION_UNMAPPED' }, { status: 403 }))
    expect(await switcher.capacity('session-a', RUNNING_A, 'reserve', actor, 'runtime')).toEqual({ ok: false, reason: 'CAPACITY_SESSION_UNMAPPED' })
    // Studio's global auth gate answers before the handler (aplus #5930): its 'Unauthorized' must not read as a capacity code.
    vi.mocked(deps.fetch).mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    expect(await switcher.capacity('session-a', RUNNING_A, 'reserve', actor, 'runtime')).toEqual({ ok: false, reason: 'CAPACITY_HTTP_401' })
    vi.mocked(deps.fetch).mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }))
    expect(await switcher.capacity('session-a', RUNNING_A, 'reserve', actor, 'runtime')).toEqual({ ok: false, reason: 'CAPACITY_HTTP_502' })
  })
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
      body: { machineId: 'pc-a', sessionId: 'session-a', companyId: 'org-a', bindingNonce: NONCE_A, selectionRequestId: expect.any(String) } })
    expect(deps.sessionEnvironment).toHaveBeenCalledWith('claude', { kind: 'claude-setup-token', managedAccountId: B, groupScope: 'org-a', credentialGeneration: 1, bindingGrant: 'claims.signature' })
    expect(result).toEqual({ ok: true, environment: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', HAPPY_AI_AUTH_SOURCE: 'org-bundle', [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding(B)) } })
    expect(deps.recordAgentEnvironment).toHaveBeenCalledWith(session, formatSetupTokenBinding(binding(B)), undefined)
  })

  it('asks Studio for an account with start budget left, as a new selection each time', async () => {
    const { switcher, requests } = setup()
    expect(await switcher.rebind('session-a', RUNNING_A, undefined, undefined, { startBudget: true })).toHaveProperty('ok', true)
    expect(requests[0].body).toMatchObject({ bindingNonce: NONCE_A, startBudget: true, selectionRequestId: expect.any(String) })
    const again = setup()
    await again.switcher.rebind('session-a', RUNNING_A, undefined, undefined, { startBudget: true })
    await again.switcher.rebind('session-a', RUNNING_A, undefined, undefined, { startBudget: true })
    // Which accounts have start budget changes between asks: a retained selection would replay a stale choice.
    expect(again.requests[0].body.selectionRequestId).not.toBe(again.requests[1].body.selectionRequestId)
    const plain = setup()
    await plain.switcher.rebind('session-a', RUNNING_A)
    expect(plain.requests[0].body).not.toHaveProperty('startBudget')
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

  // Saycode specs/setup-token-switch-usage-check — a candidate nobody measured recently is checked before the move.
  describe('checking a candidate first', () => {
    const permit = { version: 1, grant: 'grant', permitId: 'permit-c', companyId: 'org-a', managedAccountId: C, principalType: 'user', purpose: 'switch',
      machineId: 'pc-a', credentialGeneration: 1, policyRevision: 2, reservedAt: 1, transportDeadline: 10001, expiresAt: 30001 }
    const measuredObservation = { source: 'inference_probe', observedAt: 5, windows: [{ kind: 'unified5h', pct: 20, resetsAt: 50 }], coverage: 'unknown', reason: 'ok', retryAt: null }
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const studio = (rebinds: Array<{ status: number; body: Record<string, unknown> }>) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      const path = String(url).split('/daemon/')[1]
      if (path === 'rebind') { const next = rebinds.shift()!; return Response.json(next.body, { status: next.status }) }
      if (path === 'measure/reserve') return Response.json(permit)
      return Response.json({ version: 1, published: true })
    }) as unknown as typeof fetch
    const measureRequired = (managedAccountId: string) => ({ status: 409, body: { error: 'SETUP_TOKEN_DAEMON_MEASURE_REQUIRED', managedAccountId, credentialGeneration: 1 } })
    const granted = { status: 200, body: { version: 1, bindingGrant: 'claims.signature', managedAccountId: B, credentialGeneration: 1 } }

    it('measures the candidate Studio asks about, publishes the reading and asks again', async () => {
      const measure = vi.fn(async () => measuredObservation)
      requests.length = 0
      const { switcher } = setup({ measure, fetch: studio([measureRequired(C), granted]) })
      expect(await switcher.rebind('session-a', RUNNING_A)).toHaveProperty('ok', true)
      const proof = { machineId: 'pc-a', sessionId: 'session-a', companyId: 'org-a', bindingNonce: NONCE_A }
      expect(requests.map(request => [request.url.split('/daemon/')[1], request.body])).toEqual([
        ['rebind', { ...proof, selectionRequestId: expect.any(String), measureVersion: 1, measured: [] }],
        ['measure/reserve', { ...proof, managedAccountId: C, credentialGeneration: 1 }],
        ['measure/publish', { ...proof, managedAccountId: C, credentialGeneration: 1, permitId: 'permit-c', observation: measuredObservation }],
        ['rebind', { ...proof, selectionRequestId: expect.any(String), measureVersion: 1, measured: [C] }],
      ])
      expect(measure).toHaveBeenCalledWith({ companyId: 'org-a', machineId: 'pc-a', managedAccountId: C, credentialGeneration: 1, permit })
    })

    it('counts a check that told nothing, so Studio moves on to the next candidate', async () => {
      requests.length = 0
      const { switcher } = setup({ measure: vi.fn(async () => null), fetch: studio([measureRequired(C), granted]) })
      expect(await switcher.rebind('session-a', RUNNING_A)).toHaveProperty('ok', true)
      expect(requests.map(request => request.url.split('/daemon/')[1])).toEqual(['rebind', 'measure/reserve', 'rebind'])
      expect(requests[2].body.measured).toEqual([C])
    })

    it('stops after three checks in one switch', async () => {
      const ids = [B, C, '00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-00000000000e']
      requests.length = 0
      const { switcher } = setup({ measure: vi.fn(async () => null), fetch: studio(ids.map(measureRequired)) })
      expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'NO_ACCOUNT' })
      expect(requests.filter(request => request.url.endsWith('/measure/reserve'))).toHaveLength(3)
    })

    it('asks an older Studio again as before when it refuses the measurement fields', async () => {
      requests.length = 0
      const measure = vi.fn()
      const { switcher } = setup({ measure, fetch: studio([{ status: 400, body: { error: 'SETUP_TOKEN_DAEMON_INVALID_INPUT' } }, granted]) })
      expect(await switcher.rebind('session-a', RUNNING_A)).toHaveProperty('ok', true)
      expect(requests.map(request => [request.url.split('/daemon/')[1], 'measureVersion' in request.body])).toEqual([['rebind', true], ['rebind', false]])
      expect(measure).not.toHaveBeenCalled()
    })

    it('waits until the first candidate recovers when none is left', async () => {
      vi.useFakeTimers({ now: 1_000 })
      try {
        const { switcher } = setup({ measure: vi.fn(), fetch: studio([{ status: 409, body: { error: 'SETUP_TOKEN_DAEMON_NO_ACCOUNT', earliestUsableAt: 3_601_000 } }]) })
        expect(await switcher.rebind('session-a', RUNNING_A)).toEqual({ ok: false, reason: 'NO_ACCOUNT', retryAfterMs: 3_600_000 })
      } finally { vi.useRealTimers() }
    })
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

  it('moves a shared-PC binding for start budget through the runtime of its company', async () => {
    const runtime = { reportUsage: vi.fn(), rebind: vi.fn(async () => ({ NEXT: '1' })) }
    const { switcher } = setup({ machineRuntime: async () => runtime as never })
    await expect(switcher.rebind('session-a', running, undefined, undefined, { startBudget: true })).resolves.toEqual({ ok: true, environment: { NEXT: '1' } })
    expect(runtime.rebind).toHaveBeenCalledWith('session-a', running, undefined, undefined, { startBudget: true })
  })

  it('reports Studio unavailable when that company has no runtime', async () => {
    const { switcher } = setup({ machineRuntime: async () => null })
    await expect(switcher.reportUsage('session-a', running, observation)).resolves.toMatchObject({ ok: false, reason: 'STUDIO_UNAVAILABLE' })
    await expect(switcher.rebind('session-a', running, observation)).resolves.toMatchObject({ ok: false, reason: 'STUDIO_UNAVAILABLE' })
  })
})

describe('shared PC setup-token account switch (Saycode specs/shared-pc-session-account-continuation)', () => {
  const sharedRunning = sharedMachineSetupTokenAuthority({ HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1', [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: A })!
  const moved = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1', [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: B }
  function sharedSetup() {
    const sharedMachine = { reportUsage: vi.fn(async () => undefined), rebind: vi.fn(async (): Promise<Record<string, string> | null> => moved),
      environment: vi.fn(async (): Promise<Record<string, string> | null> => moved), moved: vi.fn() }
    const context = setup({ sharedMachine })
    // The daemon recorded which shared account it handed this session at spawn.
    context.session.agentEnvironment = {}
    context.session.sharedSetupTokenAccount = A
    return { ...context, sharedMachine }
  }

  it('moves an unbound shared-PC session within the accounts assigned to that PC, without Studio', async () => {
    const { switcher, requests, session, sharedMachine } = sharedSetup()
    expect(await switcher.reportUsage('session-a', sharedRunning, observation)).toEqual({ ok: true })
    expect(await switcher.rebind('session-a', sharedRunning, observation)).toEqual({ ok: true, environment: moved })
    expect(sharedMachine.reportUsage).toHaveBeenCalledWith(A, observation)
    expect(sharedMachine.rebind).toHaveBeenCalledWith(A, observation)
    expect(requests).toEqual([])
    // The record follows the move, and is saved so a restarted daemon still knows it.
    expect(session.sharedSetupTokenAccount).toBe(B)
    expect(session.sharedSetupTokenAccountsLeft).toEqual([A])
    expect(sharedMachine.moved).toHaveBeenCalledTimes(1)
  })

  it('brings a session that missed a finished move onto the account it was moved to, without moving it again', async () => {
    const { switcher, session, sharedMachine } = sharedSetup()
    expect(await switcher.rebind('session-a', sharedRunning, observation)).toEqual({ ok: true, environment: moved })
    // The session never applied that answer (stopped, timed out) and still runs on A.
    expect(await switcher.reportUsage('session-a', sharedRunning, observation)).toEqual({ ok: true })
    expect(sharedMachine.reportUsage).toHaveBeenLastCalledWith(A, observation)
    expect(await switcher.rebind('session-a', sharedRunning, observation)).toEqual({ ok: true, environment: moved })
    expect(sharedMachine.environment).toHaveBeenCalledWith(B)
    expect(sharedMachine.rebind).toHaveBeenCalledTimes(1)
    expect(session.sharedSetupTokenAccount).toBe(B)
    // When B itself can no longer be used, the session moves on from B.
    sharedMachine.environment.mockResolvedValueOnce(null)
    const third = { ...moved, [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: C }
    sharedMachine.rebind.mockResolvedValueOnce(third)
    expect(await switcher.rebind('session-a', sharedRunning, observation)).toEqual({ ok: true, environment: third })
    expect(sharedMachine.rebind).toHaveBeenLastCalledWith(B, undefined)
    expect(session.sharedSetupTokenAccount).toBe(C)
    expect(session.sharedSetupTokenAccountsLeft).toEqual([A, B])
  })

  it('stays put when no other account is usable or the PC cannot answer', async () => {
    const { switcher, session, sharedMachine } = sharedSetup()
    sharedMachine.rebind.mockResolvedValueOnce(null)
    expect(await switcher.rebind('session-a', sharedRunning, observation)).toEqual({ ok: false, reason: 'NO_ACCOUNT' })
    sharedMachine.rebind.mockRejectedValueOnce(new Error('cswap failed'))
    expect(await switcher.rebind('session-a', sharedRunning, observation)).toEqual({ ok: false, reason: 'REQUEST_FAILED' })
    expect(session.sharedSetupTokenAccount).toBe(A)
  })

  it('serves only the account the daemon handed that session', async () => {
    const { switcher, session, sharedMachine } = sharedSetup()
    const other = sharedMachineSetupTokenAuthority({ HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1', [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: B })!
    // Another account than the recorded one, an unknown session, and a session the daemon never handed a shared account.
    expect(await switcher.rebind('session-a', other, observation)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(await switcher.reportUsage('session-a', other, observation)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(await switcher.rebind('unknown-session', sharedRunning, observation)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    delete session.sharedSetupTokenAccount
    expect(await switcher.rebind('session-a', sharedRunning, observation)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(await switcher.reportUsage('session-a', sharedRunning, observation)).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(sharedMachine.rebind).not.toHaveBeenCalled()
    expect(sharedMachine.reportUsage).not.toHaveBeenCalled()
  })

  it('returns no token to a session that ended while the account was being prepared, and runs one move at a time', async () => {
    const { switcher, deps, session, sharedMachine } = sharedSetup()
    let release!: () => void
    sharedMachine.rebind.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(moved) }))
    const first = switcher.rebind('session-a', sharedRunning, observation)
    const second = switcher.rebind('session-a', sharedRunning, observation)
    deps.findSession = () => undefined
    release()
    expect(await first).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(await second).toEqual({ ok: false, reason: 'NOT_BOUND' })
    expect(sharedMachine.rebind).toHaveBeenCalledTimes(1)
    expect(session.sharedSetupTokenAccount).toBe(A)
  })
})

describe('shared PC start budget (Saycode specs/shared-pc-start-budget)', () => {
  const sharedRunning = sharedMachineSetupTokenAuthority({ HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1', [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: A })!
  const REQUEST = '00000000-0000-4000-8000-0000000000ee'
  function startSetup(answer: () => Response | Promise<Response>, extra: Partial<SetupTokenAccountSwitchDeps> = {}) {
    const sharedMachine = { reportUsage: vi.fn(async () => undefined), rebind: vi.fn(async (): Promise<Record<string, string> | null> => null),
      environment: vi.fn(async (): Promise<Record<string, string> | null> => null), moved: vi.fn(),
      startProof: vi.fn(async (): Promise<{ companyId: string; credentialGeneration: number } | null> => ({ companyId: 'org-a', credentialGeneration: 1 })),
      startBudgetMove: vi.fn(async (): Promise<Record<string, string> | null> => null) }
    const context = setup({ sharedMachine, ...extra })
    context.session.agentEnvironment = {}
    context.session.sharedSetupTokenAccount = A
    vi.mocked(context.deps.fetch).mockImplementation(async (url, init) => {
      context.requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') })
      return answer()
    })
    return { ...context, sharedMachine }
  }

  it('asks Studio with the machine\'s own token for the account the daemon handed the session', async () => {
    const wait = { version: 1, state: 'wait', retryAfterMs: 30_000, preferredAccountIds: [B] }
    const { switcher, requests } = startSetup(() => Response.json(wait))
    expect(await switcher.requestStart('session-a', sharedRunning, REQUEST)).toEqual({ ok: true, admission: wait })
    expect(requests).toEqual([{ url: 'https://studio.test/api/claude-setup-token/daemon/shared/start', authorization: 'Bearer machine-token',
      body: { machineId: 'pc-a', companyId: 'org-a', sessionId: 'session-a', managedAccountId: A, credentialGeneration: 1, requestId: REQUEST } }])
  })

  it.each([
    ['an older Studio without the route', () => new Response('{}', { status: 404 })],
    ['a Studio failure', () => new Response('{}', { status: 503 })],
    ['a refusal', () => Response.json({ error: 'SETUP_TOKEN_DAEMON_GENERATION_CHANGED' }, { status: 409 })],
    ['no answer', () => { throw new TypeError('fetch failed') }],
    ['an unreadable answer', () => new Response('not json')],
  ])('requires a positive server decision on %s', async (_name, answer) => {
    const { switcher } = startSetup(answer)
    expect(await switcher.requestStart('session-a', sharedRunning, REQUEST)).toEqual({ ok: false, reason: 'REQUEST_FAILED' })
  })

  it('moves a waiting shared-PC session onto an account Studio says has start budget left', async () => {
    const wait = { version: 1, state: 'wait', retryAfterMs: 30_000, preferredAccountIds: [B, C] }
    const { switcher, sharedMachine, session } = startSetup(() => Response.json(wait))
    const next = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1', [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: B }
    sharedMachine.startBudgetMove.mockResolvedValueOnce(next)
    await switcher.requestStart('session-a', sharedRunning, REQUEST)
    expect(await switcher.rebind('session-a', sharedRunning, undefined, undefined, { startBudget: true })).toEqual({ ok: true, environment: next })
    expect(sharedMachine.startBudgetMove).toHaveBeenCalledWith(A, [B, C])
    // A start-budget move is not a used-up account: the session's account is not reported to the PC as refused.
    expect(sharedMachine.rebind).not.toHaveBeenCalled()
    expect(session.sharedSetupTokenAccount).toBe(B)
    expect(session.sharedSetupTokenAccountsLeft).toEqual([A])
    expect(sharedMachine.moved).toHaveBeenCalledTimes(1)
  })

  it('keeps a shared-PC session waiting when Studio named no account with start budget or the PC holds none of them', async () => {
    const { switcher, sharedMachine, session } = startSetup(() => Response.json({ version: 1, state: 'wait', retryAfterMs: 30_000, preferredAccountIds: [B] }))
    // No wait answered yet: nothing names an account with budget.
    expect(await switcher.rebind('session-a', sharedRunning, undefined, undefined, { startBudget: true })).toEqual({ ok: false, reason: 'NO_ACCOUNT' })
    expect(sharedMachine.startBudgetMove).not.toHaveBeenCalled()
    await switcher.requestStart('session-a', sharedRunning, REQUEST)
    expect(await switcher.rebind('session-a', sharedRunning, undefined, undefined, { startBudget: true })).toEqual({ ok: false, reason: 'NO_ACCOUNT' })
    expect(sharedMachine.startBudgetMove).toHaveBeenCalledWith(A, [B])
    expect(session.sharedSetupTokenAccount).toBe(A)
  })

  it('forgets the accounts with start budget once the session starts or runs without a decision', async () => {
    let answer: () => Response = () => Response.json({ version: 1, state: 'wait', retryAfterMs: 30_000, preferredAccountIds: [B] })
    const { switcher, sharedMachine } = startSetup(() => answer())
    const startBudget = () => switcher.rebind('session-a', sharedRunning, undefined, undefined, { startBudget: true })
    for (const next of [() => Response.json({ version: 1, state: 'allowed', validForMs: 15_000 }), () => new Response('{}', { status: 503 }),
      () => Response.json({ version: 1, state: 'wait', retryAfterMs: 30_000, preferredAccountIds: [] })]) {
      answer = () => Response.json({ version: 1, state: 'wait', retryAfterMs: 30_000, preferredAccountIds: [B] })
      await switcher.requestStart('session-a', sharedRunning, REQUEST)
      answer = next
      await switcher.requestStart('session-a', sharedRunning, REQUEST)
      expect(await startBudget()).toEqual({ ok: false, reason: 'NO_ACCOUNT' })
    }
    expect(sharedMachine.startBudgetMove).not.toHaveBeenCalled()
  })

  it('moves a shared-PC session off an account a later sync took off this PC', async () => {
    const { switcher, requests, sharedMachine, session } = startSetup(() => Response.json({}))
    const next = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-next', HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1', [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: B }
    sharedMachine.startProof.mockResolvedValueOnce(null)
    expect(await switcher.requestStart('session-a', sharedRunning, REQUEST)).toEqual({ ok: false, reason: 'START_ACCOUNT_EXHAUSTED' })
    expect(sharedMachine.environment).toHaveBeenCalledWith(A)
    sharedMachine.rebind.mockResolvedValueOnce(next)
    expect(await switcher.rebind('session-a', sharedRunning, undefined, undefined, { startExhausted: true })).toEqual({ ok: true, environment: next })
    expect(sharedMachine.rebind).toHaveBeenCalledWith(A, undefined)
    expect(session.sharedSetupTokenAccount).toBe(B)
    expect(requests).toEqual([])
  })

  it('refuses a turn when account or Studio authority is missing', async () => {
    const { switcher, requests, sharedMachine, session } = startSetup(() => Response.json({}))
    // Still held, but without a company to prove it for: moving would not help.
    sharedMachine.startProof.mockResolvedValueOnce(null)
    sharedMachine.environment.mockResolvedValueOnce({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-a', [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: A })
    expect(await switcher.requestStart('session-a', sharedRunning, REQUEST)).toEqual({ ok: false, reason: 'REQUEST_FAILED' })
    delete session.sharedSetupTokenAccount
    expect(await switcher.requestStart('session-a', sharedRunning, REQUEST)).toEqual({ ok: false, reason: 'REQUEST_FAILED' })
    const offline = startSetup(() => Response.json({}), { studioOrigin: null })
    expect(await offline.switcher.requestStart('session-a', sharedRunning, REQUEST)).toEqual({ ok: false, reason: 'REQUEST_FAILED' })
    expect([...requests, ...offline.requests]).toEqual([])
  })
})

it('forwards authenticated failure context and rejects unsupported reason data', async () => {
 const f=setup(),failure={kind:'authentication' as const,observedAt:1000}
 vi.mocked(f.deps.fetch).mockResolvedValueOnce(Response.json({version:1,allLimited:false,availableAccountIds:[],fallbackReason:'organization-authentication'}))
 expect(await f.switcher.availability('session-a',RUNNING_A,undefined,failure)).toMatchObject({ok:true,fallbackReason:'organization-authentication'})
 expect(JSON.parse(String(vi.mocked(f.deps.fetch).mock.calls[0][1]?.body))).toHaveProperty('organizationFailure',failure)
 vi.mocked(f.deps.fetch).mockResolvedValueOnce(Response.json({version:1,allLimited:false,availableAccountIds:[],fallbackReason:['organization-lookup']}))
 expect(await f.switcher.availability('session-a',RUNNING_A)).toMatchObject({ok:false})
 vi.mocked(f.deps.fetch).mockResolvedValueOnce(Response.json({version:1,bindingGrant:'claims.signature',managedAccountId:B,credentialGeneration:1,tier:'available'}))
 expect(await f.switcher.returnFromPersonal('session-a',RUNNING_A,failure)).toMatchObject({ok:true})
 expect(JSON.parse(String(vi.mocked(f.deps.fetch).mock.calls[2][1]?.body))).toHaveProperty('organizationFailure',failure)
})

// Saycode specs/setup-token-switch-usage-check Phase 4 — a shared PC asks Studio which of its accounts to use.
describe('shared PC choice through Studio', () => {
  const held = [{ managedAccountId: A, credentialGeneration: 1 }, { managedAccountId: B, credentialGeneration: 1 }]
  const permit = { version: 1, grant: 'grant', permitId: 'permit-b', companyId: 'org-s', managedAccountId: B, principalType: 'machine', purpose: 'switch', machineId: 'pc-a', credentialGeneration: 1, policyRevision: 1 }
  const studio = (answers: Array<{ status: number; body: Record<string, unknown> }>, requests: Array<{ path: string; body: Record<string, unknown> }>) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split('/daemon/')[1]
    requests.push({ path, body: JSON.parse(String(init?.body)) })
    if (path === 'shared/select') { const next = answers.shift()!; return Response.json(next.body, { status: next.status }) }
    if (path === 'shared/measure/reserve') return Response.json(permit)
    return Response.json({ version: 1, published: true })
  }) as unknown as typeof fetch

  it('moves to the account Studio chose after checking it as the machine', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const measure = vi.fn(async () => ({ reason: 'ok' }))
    const { switcher } = setup({ measure, fetch: studio([
      { status: 409, body: { error: 'SETUP_TOKEN_DAEMON_MEASURE_REQUIRED', managedAccountId: B, credentialGeneration: 1 } },
      { status: 200, body: { version: 1, managedAccountId: B, credentialGeneration: 1 } },
    ], requests) })
    expect(await switcher.sharedChoose({ companyId: 'org-s', candidates: held, exclude: [A], measure: true })).toBe(B)
    const proof = { machineId: 'pc-a', companyId: 'org-s' }
    expect(requests).toEqual([
      { path: 'shared/select', body: { ...proof, selectionRequestId: expect.any(String), candidates: held, exclude: [A], measure: true, measured: [] } },
      { path: 'shared/measure/reserve', body: { ...proof, managedAccountId: B, credentialGeneration: 1 } },
      { path: 'shared/measure/publish', body: { ...proof, managedAccountId: B, credentialGeneration: 1, permitId: 'permit-b', observation: { reason: 'ok' } } },
      { path: 'shared/select', body: { ...proof, selectionRequestId: expect.any(String), candidates: held, exclude: [A], measure: true, measured: [B] } },
    ])
    expect(requests[0].body.selectionRequestId).toBe(requests[3].body.selectionRequestId)
    expect(measure).toHaveBeenCalledWith({ companyId: 'org-s', machineId: 'pc-a', managedAccountId: B, credentialGeneration: 1, permit })
  })

  it('answers no account when Studio has none, and unknown when Studio cannot answer', async () => {
    const { switcher } = setup({ fetch: studio([{ status: 409, body: { error: 'SETUP_TOKEN_DAEMON_NO_ACCOUNT', earliestUsableAt: null } }], []) })
    expect(await switcher.sharedChoose({ companyId: 'org-s', candidates: held, exclude: [A], measure: true })).toBeNull()
    const down = setup({ fetch: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch })
    expect(await down.switcher.sharedChoose({ companyId: 'org-s', candidates: held, exclude: [], measure: false })).toBeUndefined()
    const refused = setup({ fetch: studio([{ status: 403, body: { error: 'SETUP_TOKEN_DAEMON_MACHINE_FORBIDDEN' } }], []) })
    expect(await refused.switcher.sharedChoose({ companyId: 'org-s', candidates: held, exclude: [], measure: false })).toBeUndefined()
    const noOrigin = setup({ studioOrigin: null })
    expect(await noOrigin.switcher.sharedChoose({ companyId: 'org-s', candidates: held, exclude: [], measure: false })).toBeUndefined()
  })

  it('asks a Studio that refuses selectionRequestId again without it, once', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const refusal = { status: 400, body: { error: 'INVALID_INPUT' } }
    const { switcher } = setup({ fetch: studio([refusal, { status: 200, body: { version: 1, managedAccountId: B, credentialGeneration: 1 } }], requests) })
    expect(await switcher.sharedChoose({ companyId: 'org-s', candidates: held, exclude: [A], measure: true })).toBe(B)
    expect(requests.map(r => 'selectionRequestId' in r.body)).toEqual([true, false])
    expect(requests[1].body).toEqual({ machineId: 'pc-a', companyId: 'org-s', candidates: held, exclude: [A], measure: true, measured: [] })
    const stillRefused = setup({ fetch: studio([refusal, refusal], []) })
    expect(await stillRefused.switcher.sharedChoose({ companyId: 'org-s', candidates: held, exclude: [], measure: false })).toBeUndefined()
    expect(vi.mocked(stillRefused.deps.fetch)).toHaveBeenCalledTimes(2)
  })
})

it('carries authentication failure to rebind with the running binding proof before accepting another token', async () => {
 const { switcher, requests } = setup()
 expect(await switcher.rebind('session-a', RUNNING_A, { observedAt: 100, reason: 'authentication-failed', windows: [], retryAt: null })).toHaveProperty('ok', true)
 expect(requests[0].body).toMatchObject({ bindingNonce: NONCE_A, organizationFailure: { kind: 'authentication', observedAt: 100 } })
})

it('stores an authorized manual choice only at commit and does not forward local commit flags to Studio', async () => {
 const f=setup({fetch:vi.fn(async()=>Response.json({version:1,allLimited:false,availableAccountIds:[A],consentApproved:true})) as typeof fetch})
 const consent={purpose:'manual' as const,proof:'fixture-proof',accountRef:'a'.repeat(64),nonce:'b'.repeat(48)}
 expect(await f.switcher.availability('session-a',RUNNING_A,consent)).toMatchObject({ok:true,consentApproved:true})
 expect(f.deps.recordAgentEnvironment).not.toHaveBeenCalled()
 expect(await f.switcher.availability('session-a',RUNNING_A,{...consent,commit:true})).toMatchObject({ok:true,consentApproved:true})
 expect(f.deps.recordAgentEnvironment).toHaveBeenCalledWith(f.session,RUNNING_A,consent.accountRef)
 const sent=JSON.parse(String(vi.mocked(f.deps.fetch).mock.calls[1][1]?.body))
 expect(sent.personalConsent).toEqual(consent)
})

it.each(['committed', 'failed'] as const)('keeps a manual choice atomic with ordinary rebind (%s)', async status => {
 const f=setup(), key='HAPPY_AI_AUTH_MANUAL_PERSONAL', ref='a'.repeat(64)
 f.session.agentEnvironment![key]=ref
 vi.mocked(f.deps.recordAgentEnvironment).mockImplementation((_session,next,manualRef)=>{
  if(status==='committed') { f.session.agentEnvironment![SETUP_TOKEN_BINDING_ENV]=next; if(manualRef===null) delete f.session.agentEnvironment![key] }
  return {status}
 })
 await f.switcher.rebind('session-a',RUNNING_A)
 expect(f.deps.recordAgentEnvironment).toHaveBeenCalledWith(f.session,expect.any(String),undefined)
 expect(f.deps.recordAgentEnvironment).toHaveBeenCalledTimes(1)
 expect(f.session.agentEnvironment![key]).toBe(ref)
})

it('clears a manual choice only in the durable explicit organization return', async () => {
 const f=setup(); f.session.agentEnvironment!['HAPPY_AI_AUTH_MANUAL_PERSONAL']='a'.repeat(64)
 vi.mocked(f.deps.fetch).mockResolvedValueOnce(Response.json({version:1,bindingGrant:'claims.signature',managedAccountId:B,credentialGeneration:1,tier:'available'}))
 await f.switcher.returnFromPersonal('session-a',RUNNING_A)
 expect(f.deps.recordAgentEnvironment).toHaveBeenCalledWith(f.session,expect.any(String),null)
})

it('reselects a confirmed organization account after an ordinary rebind save failed', async () => {
 const f=setup(), key='HAPPY_AI_AUTH_MANUAL_PERSONAL', ref='a'.repeat(64)
 f.session.agentEnvironment![key]=ref
 let writes=0
 vi.mocked(f.deps.recordAgentEnvironment).mockImplementation((session,next,manualRef)=>{
  if(++writes===1) return {status:'failed'}
  session.agentEnvironment![SETUP_TOKEN_BINDING_ENV]=next
  if(manualRef===null) delete session.agentEnvironment![key]
  return {status:'committed'}
 })
 vi.mocked(f.deps.fetch).mockResolvedValueOnce(Response.json({version:1,bindingGrant:'ordinary.signature',managedAccountId:B,credentialGeneration:1,tier:'unknown'}))
  .mockResolvedValueOnce(Response.json({version:1,bindingGrant:'return.signature',managedAccountId:C,credentialGeneration:1,tier:'available'}))
 vi.mocked(f.deps.sessionEnvironment).mockImplementation(async (_agent,selection)=>{
  if(selection.kind!=='claude-setup-token') throw new Error('Unexpected selection')
  return {CLAUDE_CODE_OAUTH_TOKEN:'synthetic-next',[SETUP_TOKEN_BINDING_ENV]:formatSetupTokenBinding(binding(selection.managedAccountId))}
 })
 expect(await f.switcher.rebind('session-a',RUNNING_A)).toEqual({ok:false,reason:'PERSISTENCE_FAILED'})
 expect(f.session.agentEnvironment![key]).toBe(ref)
 expect(await f.switcher.returnFromPersonal('session-a',RUNNING_A)).toMatchObject({ok:true,environment:{[SETUP_TOKEN_BINDING_ENV]:formatSetupTokenBinding(binding(C))}})
 const calls=vi.mocked(f.deps.fetch).mock.calls
 expect(calls.map(call=>String(call[0]).split('/').pop())).toEqual(['rebind','return'])
 expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({bindingNonce:NONCE_A})
 expect(f.deps.recordAgentEnvironment).toHaveBeenLastCalledWith(f.session,formatSetupTokenBinding(binding(C)),null)
 expect(f.session.agentEnvironment![key]).toBeUndefined()
})

it.each(['indeterminate','throw'] as const)('keeps an uncertain ordinary publication blocked during explicit return (%s)', async outcome => {
 const record=vi.fn(()=>{ if(outcome==='throw') throw new Error('Uncertain publication'); return {status:'indeterminate' as const} })
 const f=setup({recordAgentEnvironment:record})
 expect(await f.switcher.rebind('session-a',RUNNING_A)).toEqual({ok:false,reason:'PERSISTENCE_INDETERMINATE'})
 expect(await f.switcher.returnFromPersonal('session-a',RUNNING_A)).toEqual({ok:false,reason:'PERSISTENCE_INDETERMINATE'})
 expect(f.deps.fetch).toHaveBeenCalledTimes(1); expect(record).toHaveBeenCalledTimes(1)
})

it('refuses an ordinary rebind over a pending explicit organization return', async () => {
 const f=setup({recordAgentEnvironment:vi.fn(()=>({status:'failed' as const}))})
 vi.mocked(f.deps.fetch).mockResolvedValueOnce(Response.json({version:1,bindingGrant:'return.signature',managedAccountId:B,credentialGeneration:1,tier:'available'}))
 expect(await f.switcher.returnFromPersonal('session-a',RUNNING_A)).toEqual({ok:false,reason:'PERSISTENCE_FAILED'})
 expect(await f.switcher.rebind('session-a',RUNNING_A)).toEqual({ok:false,reason:'STALE'})
 expect(f.deps.fetch).toHaveBeenCalledTimes(1); expect(f.deps.recordAgentEnvironment).toHaveBeenCalledTimes(1)
})

it('requests start admission using only the current authenticated binding', async () => {
 const {switcher,deps,requests}=setup()
 vi.mocked(deps.fetch).mockResolvedValueOnce(Response.json({version:1,state:'allowed',validForMs:15000}))
 expect(await switcher.requestStart('session-a',RUNNING_A,'start-1')).toEqual({ok:true,admission:{version:1,state:'allowed',validForMs:15000}})
 expect(requests).toHaveLength(0) // overridden fetch below is inspected directly
 expect(vi.mocked(deps.fetch).mock.calls[0][0]).toBe('https://studio.test/api/claude-setup-token/daemon/start')
 expect(JSON.parse(String(vi.mocked(deps.fetch).mock.calls[0][1]?.body))).toEqual({machineId:'pc-a',sessionId:'session-a',companyId:'org-a',bindingNonce:NONCE_A,requestId:'start-1'})
 expect((await switcher.requestStart('other-session',RUNNING_A,'start-2')).ok).toBe(false)
 expect(deps.fetch).toHaveBeenCalledTimes(1)
})


it('excludes PC-disabled accounts from both start admission and rebind without enabling them', async () => {
 const f=setup({disabledSetupTokenAccounts:vi.fn(async()=>[B])})
 vi.mocked(f.deps.fetch).mockImplementation(async(url,init)=>{
  const body=JSON.parse(String(init?.body))
  if(String(url).endsWith('/start'))return Response.json({version:1,state:'wait',retryAfterMs:30000,preferredAccountIds:[C]})
  const id=body.excludeManagedAccountIds?.includes(B)?C:B
  return Response.json({version:1,bindingGrant:'fixture.signature',managedAccountId:id,credentialGeneration:1})
 })
 vi.mocked(f.deps.sessionEnvironment).mockImplementation(async(_agent,selection)=>({CLAUDE_CODE_OAUTH_TOKEN:'sk-ant-oat01-fixture',[SETUP_TOKEN_BINDING_ENV]:formatSetupTokenBinding(binding((selection as {managedAccountId:string}).managedAccountId))}))
 expect(await f.switcher.requestStart('session-a',RUNNING_A,'start-1')).toMatchObject({ok:true,admission:{state:'wait'}})
 expect(JSON.parse(String(vi.mocked(f.deps.fetch).mock.calls[0][1]?.body))).toMatchObject({excludeManagedAccountIds:[B]})
 expect(await f.switcher.rebind('session-a',RUNNING_A,undefined,undefined,{startBudget:true})).toMatchObject({ok:true})
 expect(JSON.parse(String(vi.mocked(f.deps.fetch).mock.calls[1][1]?.body))).toMatchObject({excludeManagedAccountIds:[B]})
 expect(f.deps.sessionEnvironment).toHaveBeenCalledWith('claude',expect.objectContaining({managedAccountId:C}))
 expect(f.deps.recordAgentEnvironment).toHaveBeenCalledTimes(1)
})

it('returns no account once when all replacement candidates are disabled without consuming a grant', async () => {
 const f=setup({disabledSetupTokenAccounts:async()=>[B,C]})
 vi.mocked(f.deps.fetch).mockImplementation(async(_url,init)=>{
  const body=JSON.parse(String(init?.body))
  return body.excludeManagedAccountIds?.length===2?Response.json({error:'SETUP_TOKEN_DAEMON_NO_ACCOUNT'},{status:409}):Response.json({version:1,bindingGrant:'fixture.signature',managedAccountId:B,credentialGeneration:1})
 })
 expect(await f.switcher.rebind('session-a',RUNNING_A)).toEqual({ok:false,reason:'NO_ACCOUNT'})
 expect(f.deps.fetch).toHaveBeenCalledTimes(1)
 expect(f.deps.sessionEnvironment).not.toHaveBeenCalled()
 expect(f.deps.recordAgentEnvironment).not.toHaveBeenCalled()
 expect(f.session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(RUNNING_A)
})

it('does not drop disabled-account exclusions when an older Studio rejects them', async () => {
 const f=setup({disabledSetupTokenAccounts:async()=>[B]})
 vi.mocked(f.deps.fetch).mockResolvedValue(Response.json({error:'INVALID_INPUT'},{status:400}))
 expect(await f.switcher.rebind('session-a',RUNNING_A)).toEqual({ok:false,reason:'REQUEST_FAILED'})
 expect(f.deps.fetch).toHaveBeenCalledTimes(2)
 for(const [,init] of vi.mocked(f.deps.fetch).mock.calls)expect(JSON.parse(String(init?.body))).toMatchObject({excludeManagedAccountIds:[B]})
 expect(f.deps.sessionEnvironment).not.toHaveBeenCalled()
 expect(f.deps.recordAgentEnvironment).not.toHaveBeenCalled()
})

it.each([[409,'SETUP_TOKEN_DAEMON_START_ACCOUNT_EXHAUSTED','START_ACCOUNT_EXHAUSTED'],[409,'SETUP_TOKEN_DAEMON_START_ACCOUNT_UNAVAILABLE','REQUEST_FAILED'],[403,'SETUP_TOKEN_DAEMON_START_ACCOUNT_EXHAUSTED','FORBIDDEN']])('preserves only authenticated confirmed start exhaustion (%s, %s)',async(status,error,reason)=>{
 const {switcher}=setup({fetch:vi.fn(async()=>Response.json({error},{status})) as typeof fetch})
 expect(await switcher.requestStart('session-a',RUNNING_A,'start-1')).toEqual({ok:false,reason})
})
it('passes start exhaustion as a distinct rebind reason',async()=>{
 const {switcher,requests}=setup()
 expect((await switcher.rebind('session-a',RUNNING_A,undefined,undefined,{startExhausted:true})).ok).toBe(true)
 expect(requests[0].body).toMatchObject({startExhausted:true})
 expect(requests[0].body).not.toHaveProperty('startBudget')
})

it('logs start refusal status and code without logging arbitrary response data',async()=>{
 const debug=vi.spyOn(logger,'debug')
 try{
  const {switcher}=setup({fetch:vi.fn(async()=>Response.json({error:'SETUP_TOKEN_DAEMON_START_ACCOUNT_EXHAUSTED',token:'do-not-log'},{status:409})) as typeof fetch})
  await switcher.requestStart('session-a',RUNNING_A,'request')
  expect(debug).toHaveBeenCalledWith('[setup-token-switch] START_ACCOUNT_EXHAUSTED: start refused: HTTP 409 SETUP_TOKEN_DAEMON_START_ACCOUNT_EXHAUSTED')
  expect(debug.mock.calls.flat().join(' ')).not.toContain('do-not-log')
 }finally{debug.mockRestore()}
})
