import { describe, expect, it, vi } from 'vitest'
import { probeHappyCodex, codexRecoveryErrorKind } from './codexRecoveryProbe'

function client(failure?: string, completion: Record<string, unknown> = { type: 'task_complete', status: 'completed' }, native = true) {
  let handler: (event: Record<string, unknown>) => void = () => undefined
  return {
    setEventHandler: vi.fn(callback => { handler = callback }),
    setApprovalHandler: vi.fn(),
    connect: vi.fn(async () => { if (failure) throw new Error(failure) }),
    startThread: vi.fn(async () => ({ threadId: 'probe-thread', model: 'gpt-6.1-sol' })),
    sendTurnAndWait: vi.fn(async (_prompt: string, options?: { onCompleted?: (id: string, thread: null) => void; onCompletionObservationSettled?: () => void }) => {
      handler({ type: 'agent_message', message: 'SHARED_AI_OK' })
      handler(completion)
      if (native && completion.type === 'task_complete' && completion.status === 'completed' && !completion.error && !completion.reason) options?.onCompleted?.('probe-turn', null)
      options?.onCompletionObservationSettled?.()
      return { aborted: false }
    }),
    disconnect: vi.fn(async () => undefined),
  }
}

describe('Happy Codex recovery probe', () => {
  it('requires a completed inference turn and a real reply through the Happy client', async () => {
    const instance = client()
    const result = await probeHappyCodex('/tmp/probe', () => instance)
    expect(result).toEqual({ ok: true, model: 'gpt-6.1-sol', attempts: 1 })
    expect(instance.startThread).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'read-only', approvalPolicy: 'never', cwd: '/tmp/probe' }))
    expect(instance.sendTurnAndWait).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SHARED_AI_OK'), expect.objectContaining({ turnTimeoutMs: 30_000 }))
    expect(instance.disconnect).toHaveBeenCalledOnce()
  })
  it('does not accept initialization or a failed turn as successful authentication', async () => {
    const instance = client()
    instance.sendTurnAndWait.mockImplementation(async () => ({ aborted: false }))
    expect(await probeHappyCodex('/tmp/probe', () => instance)).toMatchObject({ ok: false, errorKind: 'CODEX_RESPONSE_NOT_VERIFIED' })
  })
  it('does not accept a UI completion fallback without an authoritative provider completion', async () => {
    expect(await probeHappyCodex('/tmp/probe', () => client(undefined, { type: 'task_complete', status: 'completed' }, false)))
      .toMatchObject({ ok: false, errorKind: 'CODEX_RESPONSE_NOT_VERIFIED' })
  })
  it.each([
    [{ type: 'task_complete', status: 'completed', error: { message: 'unauthorized 401 private-token' } }, 'CODEX_AUTHENTICATION_FAILED'],
    [{ type: 'task_complete', status: 'failed', error: { message: 'network error' } }, 'CODEX_NETWORK_ERROR'],
    [{ type: 'turn_aborted' }, 'CODEX_RESPONSE_NOT_VERIFIED'],
    [{ type: 'task_complete', status: 'completed', reason: 'inactivity_timeout' }, 'CODEX_RESPONSE_NOT_VERIFIED'],
  ])('rejects a reply followed by an erroneous terminal event %j', async (completion, errorKind) => {
    expect(await probeHappyCodex('/tmp/probe', () => client(undefined, completion))).toMatchObject({ ok: false, errorKind })
  })
  it('disposes the timed-out process and retries once with a fresh Happy client', async () => {
    const failed = client('initialize timed out after 30000ms (id=1)')
    const ready = client()
    const factory = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(ready)
    expect(await probeHappyCodex('/tmp/probe', factory)).toEqual({ ok: true, model: 'gpt-6.1-sol', attempts: 2 })
    expect(failed.disconnect).toHaveBeenCalledOnce()
    expect(ready.disconnect).toHaveBeenCalledOnce()
  })
  it('keeps persistent initialization failure distinct from a rejected OAuth token', async () => {
    expect(await probeHappyCodex('/tmp/probe', () => client('initialize timed out after 30000ms')))
      .toEqual({ ok: false, errorKind: 'CODEX_INITIALIZE_TIMEOUT', attempts: 2 })
    const factory = vi.fn(() => client('workspace routing discovery unauthorized (401) secret-token'))
    expect(await probeHappyCodex('/tmp/probe', factory))
      .toEqual({ ok: false, errorKind: 'CODEX_AUTHENTICATION_FAILED', attempts: 1 })
    expect(factory).toHaveBeenCalledOnce()
  })
  it('returns a bounded failure when the client cannot be created', async () => {
    expect(await probeHappyCodex('/tmp/probe', () => { throw new Error('ENOENT private-path') }))
      .toEqual({ ok: false, errorKind: 'CODEX_CLI_UNAVAILABLE', attempts: 1 })
  })
  it('does not report success or retry while the probe child cannot be disposed', async () => {
    const instance = client('initialize timed out after 30000ms')
    instance.disconnect.mockRejectedValue(new Error('private cleanup detail'))
    const factory = vi.fn(() => instance)
    expect(await probeHappyCodex('/tmp/probe', factory))
      .toEqual({ ok: false, errorKind: 'CODEX_RESPONSE_NOT_VERIFIED', attempts: 1 })
    expect(factory).toHaveBeenCalledOnce()
  })
  it.each([
    ['refresh token was revoked', 'CODEX_REAUTH_REQUIRED'],
    ['selected workspace missing from routing discovery', 'CODEX_WORKSPACE_UNAVAILABLE'],
    ['ENOTFOUND auth.openai.com', 'CODEX_NETWORK_ERROR'],
    ['Codex CLI is not installed', 'CODEX_CLI_UNAVAILABLE'],
  ])('classifies %s without leaking provider output', (error, kind) => {
    expect(codexRecoveryErrorKind(new Error(error))).toBe(kind)
  })
})
