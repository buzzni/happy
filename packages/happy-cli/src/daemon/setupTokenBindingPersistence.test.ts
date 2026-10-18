/** Tests the daemon callback used by run.ts, without starting a daemon or contacting Studio. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { persistSessionDurably, type SessionPersistenceResult } from '@/persistence'
import { persistSetupTokenBinding } from './setupTokenBindingPersistence'
import { SETUP_TOKEN_BINDING_ENV } from './sessionEnv'
import type { TrackedSession } from './types'

vi.mock('@/persistence', () => ({ persistSessionDurably: vi.fn() }))

function tracked(): TrackedSession {
  return {
    startedBy: 'daemon', pid: 123, happySessionId: 'session-a',
    happySessionMetadataFromLocalWebhook: { path: '/project', host: 'host' } as TrackedSession['happySessionMetadataFromLocalWebhook'],
    encryption: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey', seq: 7, metadataVersion: 3, agentStateVersion: 2 },
    userHomeDir: '/staged-home', persistedLastProcessedSeq: 6, deferredContinuationContextFile: '/context',
    agentEnvironment: { [SETUP_TOKEN_BINDING_ENV]: 'binding-a', SAYCODE_AGENT_ID: 'session-a' } as TrackedSession['agentEnvironment'],
  }
}

beforeEach(() => vi.resetAllMocks())

describe('daemon setup-token binding persistence callback', () => {
  it.each(['happySessionId', 'encryption', 'happySessionMetadataFromLocalWebhook'] as const)('fails closed with missing %s', field => {
    const session = tracked()
    delete session[field]
    const committed = session.agentEnvironment
    expect(persistSetupTokenBinding(session, 'binding-b')).toEqual({ status: 'failed' })
    expect(session.agentEnvironment).toBe(committed)
    expect(persistSessionDurably).not.toHaveBeenCalled()
  })

  it.each(['failed', 'indeterminate'] as const)('keeps committed memory on %s publication', status => {
    const session = tracked()
    const committed = session.agentEnvironment
    vi.mocked(persistSessionDurably).mockReturnValue({ status })
    expect(persistSetupTokenBinding(session, 'binding-b')).toEqual({ status })
    expect(session.agentEnvironment).toBe(committed)
    expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe('binding-a')
  })

  it('writes the complete candidate with old memory intact; advances only after ACK and isolates other sessions', () => {
    const session = tracked()
    const other = tracked()
    const committed = session.agentEnvironment
    vi.mocked(persistSessionDurably).mockImplementation((id, record): SessionPersistenceResult => {
      expect(session.agentEnvironment).toBe(committed)
      expect(id).toBe('session-a')
      expect(record).toEqual({
        encryptionKey: Buffer.alloc(32, 1).toString('base64'), encryptionVariant: 'dataKey', seq: 7, metadataVersion: 3, agentStateVersion: 2,
        metadata: session.happySessionMetadataFromLocalWebhook, savedAt: expect.any(Number), userHomeDir: '/staged-home',
        lastProcessedSeq: 6, deferredContinuationContextFile: '/context',
        agentEnvironment: { ...committed, [SETUP_TOKEN_BINDING_ENV]: 'binding-b' },
      })
      return { status: 'committed' }
    })
    expect(persistSetupTokenBinding(session, 'binding-b')).toEqual({ status: 'committed' })
    expect(session.agentEnvironment).toEqual({ ...committed, [SETUP_TOKEN_BINDING_ENV]: 'binding-b' })
    expect(other.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe('binding-a')
  })
})
