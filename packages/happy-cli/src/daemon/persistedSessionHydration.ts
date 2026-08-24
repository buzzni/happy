/**
 * Restoring a TrackedSession's resume-critical fields from the on-disk store.
 *
 * The daemon builds TrackedSessions from three sources: the session-started
 * webhook (full data), the previous daemon's state file, and orphan runtime
 * reports. Only the webhook carries `encryption`, so the other two used to
 * produce sessions that looked tracked but could never be preserved for resume
 * — `preserveSessionForResume` bails without it. The reaper then killed such a
 * session without ever writing its `lastProcessedSeq` to disk, and every later
 * resume refused with SESSION_CURSOR_MISSING (2026-08-15 incident: a message
 * sent from the app was accepted by the server and answered by nobody).
 *
 * `sessions.json` already holds everything those two paths lack, so this is a
 * lookup, not a reconstruction.
 */

import { decodeBase64 } from '@/api/encryption';
import type { PersistedSession } from '@/persistence';
import type { TrackedSession } from './types';

type HydratedFields = Pick<
  TrackedSession,
  'happySessionMetadataFromLocalWebhook' | 'encryption' | 'userHomeDir' | 'persistedLastProcessedSeq' | 'agentEnvironment'
>;

/**
 * Fields to merge into a TrackedSession that was built without them.
 *
 * Keys the record doesn't carry are omitted rather than set to undefined, so
 * the result is safe to spread over a session that already holds fresher
 * values.
 *
 * `runtime` is deliberately never produced here: the idle guard's
 * stale-runtime protection keys off its absence, so fabricating one from a
 * persisted cursor would make a silent session look freshly reported.
 */
export function hydrateTrackedSessionFromPersisted(persisted: PersistedSession | undefined): HydratedFields {
  if (!persisted) return {};

  return {
    happySessionMetadataFromLocalWebhook: persisted.metadata,
    encryption: {
      encryptionKey: decodeBase64(persisted.encryptionKey),
      encryptionVariant: persisted.encryptionVariant,
      seq: persisted.seq,
      metadataVersion: persisted.metadataVersion,
      agentStateVersion: persisted.agentStateVersion,
    },
    ...(persisted.userHomeDir ? { userHomeDir: persisted.userHomeDir } : {}),
    ...(persisted.lastProcessedSeq !== undefined
      ? { persistedLastProcessedSeq: persisted.lastProcessedSeq }
      : {}),
    ...(persisted.agentEnvironment ? { agentEnvironment: persisted.agentEnvironment } : {}),
  };
}
