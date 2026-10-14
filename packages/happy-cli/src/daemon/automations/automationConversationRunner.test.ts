import { describe, expect, it, vi } from 'vitest'
import { deliverAutomationConversation } from './automationConversationRunner'
const request = { runId: 'r1', claimToken: 'token', sessionId: 's1', directory: '/chat', prompt: 'Report' }
function setup() {
  return { resolveSession: vi.fn(() => ({ directory: '/chat', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const })), sameDirectory: vi.fn(async () => true), ensureRunning: vi.fn(async () => true), readSeq: vi.fn(async () => 4), encryptUserMessage: vi.fn<Parameters<typeof deliverAutomationConversation>[1]['encryptUserMessage']>(() => 'ciphertext'), deliver: vi.fn<Parameters<typeof deliverAutomationConversation>[1]['deliver']>(async () => ({ ok: true })) }
}
describe('ordinary conversation delivery', () => {
  it('resumes the fixed ordinary session and appends a normal user envelope', async () => {
    const deps = setup(); expect(await deliverAutomationConversation(request, deps)).toEqual({ ok: true, sessionId: 's1' })
    expect(deps.ensureRunning).toHaveBeenCalledWith('s1'); expect(deps.deliver).toHaveBeenCalledWith({ wireVersion: 1, runId: 'r1', claimToken: 'token', sessionId: 's1', expectedSeq: 4, contentCiphertext: 'ciphertext' })
    expect(deps.encryptUserMessage.mock.calls[0]?.[1]).toMatchObject({ role: 'user', content: { type: 'text', text: 'Report' }, localKey: 'happy-automation:r1', meta: { sentFrom: 'automation' } })
  })
  it('does not execute without local binding or a matching canonical directory', async () => {
    const deps = setup(); deps.sameDirectory.mockResolvedValue(false)
    expect(await deliverAutomationConversation(request, deps)).toMatchObject({ ok: false }); expect(deps.ensureRunning).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled()
  })
  it('rechecks a sequence changed by a manual prompt and keeps the same run identity', async () => {
    const deps = setup(); deps.deliver.mockResolvedValueOnce({ ok: false, error: 'session-changed' } as never)
    deps.readSeq.mockResolvedValueOnce(4).mockResolvedValueOnce(6)
    expect(await deliverAutomationConversation(request, deps)).toMatchObject({ ok: true }); expect(deps.deliver.mock.calls.map(([input]) => input.expectedSeq)).toEqual([4, 6])
  })
  it('retries an unknown ACK using the same delivery identity, and stops on a revoked claim', async () => {
    const deps = setup(); deps.deliver.mockRejectedValueOnce(new Error('ack lost'))
    expect(await deliverAutomationConversation(request, deps)).toMatchObject({ ok: true }); expect(deps.deliver).toHaveBeenCalledTimes(2)
    deps.deliver.mockClear().mockResolvedValue({ ok: false, error: 'claim-cancelled' } as never)
    expect(await deliverAutomationConversation(request, deps)).toMatchObject({ ok: false }); expect(deps.deliver).toHaveBeenCalledTimes(1)
  })
})
