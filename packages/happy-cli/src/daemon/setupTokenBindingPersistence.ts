/** Publishes a session's setup-token resume authority before changing its committed in-memory binding. */
import { encodeBase64 } from '@/api/encryption'
import { persistSessionDurably, type SessionPersistenceResult } from '@/persistence'
import { SETUP_TOKEN_BINDING_ENV } from './sessionEnv'
import type { TrackedSession } from './types'

export function persistSetupTokenBinding(session: TrackedSession, binding: string): SessionPersistenceResult {
  const sessionId = session.happySessionId
  const metadata = session.happySessionMetadataFromLocalWebhook
  const encryption = session.encryption
  if (!sessionId || !encryption || !metadata) return { status: 'failed' }
  const agentEnvironment = { ...session.agentEnvironment, [SETUP_TOKEN_BINDING_ENV]: binding }
  const result = persistSessionDurably(sessionId, {
    encryptionKey: encodeBase64(encryption.encryptionKey),
    encryptionVariant: encryption.encryptionVariant,
    seq: encryption.seq,
    metadataVersion: encryption.metadataVersion,
    agentStateVersion: encryption.agentStateVersion,
    metadata,
    savedAt: Date.now(),
    userHomeDir: session.userHomeDir,
    lastProcessedSeq: session.persistedLastProcessedSeq,
    agentEnvironment,
    deferredContinuationContextFile: session.deferredContinuationContextFile,
  })
  if (result.status === 'committed') session.agentEnvironment = agentEnvironment
  return result
}
