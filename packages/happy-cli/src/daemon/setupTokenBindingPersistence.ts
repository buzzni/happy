import { MANUAL_PERSONAL_ENV } from './manualPersonalClaude'
/** Publishes a session's setup-token resume authority before changing its committed in-memory binding. */
import { encodeBase64 } from '@/api/encryption'
import { persistSessionDurably, recoverPersistedSessionDurably, type SessionPersistenceResult } from '@/persistence'
import { SETUP_TOKEN_BINDING_ENV } from './sessionEnv'
import type { TrackedSession } from './types'

export function persistSetupTokenBinding(session: TrackedSession, binding: string, manualRef?: string | null): SessionPersistenceResult {
  const sessionId = session.happySessionId
  const metadata = session.happySessionMetadataFromLocalWebhook
  const encryption = session.encryption
  if (!sessionId || !encryption || !metadata) return { status: 'failed' }
  const agentEnvironment = { ...session.agentEnvironment, [SETUP_TOKEN_BINDING_ENV]: binding }
  if (manualRef === null) delete agentEnvironment[MANUAL_PERSONAL_ENV]
  else if (manualRef !== undefined) agentEnvironment[MANUAL_PERSONAL_ENV] = manualRef
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

/** Called only after authenticated operation/execution query; re-ACKs an uncertain existing publication. */
export function recoverSetupTokenBindingPersistence(session: TrackedSession, binding: string): SessionPersistenceResult {
  if (!session.happySessionId) return { status: 'failed' }
  const result = recoverPersistedSessionDurably(session.happySessionId, binding)
  if (result.status === 'committed') session.agentEnvironment = { ...session.agentEnvironment, [SETUP_TOKEN_BINDING_ENV]: binding }
  return result
}
