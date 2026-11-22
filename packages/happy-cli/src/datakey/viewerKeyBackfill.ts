/**
 * aplus-dev-studio specs/script-automation-viewer-key R2 — a machine switched
 * to dataKey before access.key kept the automation viewer public key recovers
 * it once from its own legacy backup. The backup is trusted only for the
 * account key access.key is bound to; the machine key may have been replaced
 * since, and a company key reseed rewrites the backup's key with access.key's.
 */
import { readFile } from 'node:fs/promises'

import { configuration } from '@/configuration'
import { parseCredentials, replaceCredentialsDataKey, type Credentials } from '@/persistence'
import { deriveContentKeyPair } from '@/resume/localHappyAgentAuth'
import { logger } from '@/ui/logger'

export type ViewerKeyBackfillPlan =
  | { ok: true; viewerPublicKey: Uint8Array }
  | { ok: false; reason: 'not-datakey' | 'already-kept' | 'no-backup' | 'backup-invalid' | 'other-account' }

const sameKey = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index])

export function planViewerKeyBackfill(input: { credentials: Credentials; rawBackup: unknown | null }): ViewerKeyBackfillPlan {
  const encryption = input.credentials.encryption
  if (encryption.type !== 'dataKey') return { ok: false, reason: 'not-datakey' }
  if (encryption.viewerPublicKey) return { ok: false, reason: 'already-kept' }
  if (input.rawBackup === null) return { ok: false, reason: 'no-backup' }
  const backup = parseCredentials(input.rawBackup)
  if (backup?.encryption.type !== 'legacy' || !backup.encryption.provisioned) return { ok: false, reason: 'backup-invalid' }
  if (!sameKey(backup.encryption.provisioned.publicKey, encryption.publicKey)) return { ok: false, reason: 'other-account' }
  return { ok: true, viewerPublicKey: deriveContentKeyPair(backup.encryption.secret).publicKey }
}

async function readBackup(): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(`${configuration.privateKeyFile}.legacy-backup`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    return 'unparseable'
  }
}

/** Returns the credential that now carries the key, or the one given when nothing was written. */
export async function backfillViewerPublicKey(credentials: Credentials): Promise<Credentials> {
  if (credentials.encryption.type !== 'dataKey') return credentials
  const encryption = credentials.encryption
  try {
    const plan = planViewerKeyBackfill({ credentials, rawBackup: await readBackup() })
    if (!plan.ok) {
      if (plan.reason === 'backup-invalid' || plan.reason === 'other-account') {
        logger.debug(`[DATAKEY] Automation viewer key not recovered: ${plan.reason}`)
      }
      return credentials
    }
    const kept: Credentials = { ...credentials, encryption: { ...encryption, viewerPublicKey: plan.viewerPublicKey } }
    await replaceCredentialsDataKey({
      token: credentials.token,
      publicKey: encryption.publicKey,
      machineKey: encryption.machineKey,
      neverEscrowed: encryption.neverEscrowed === true,
      viewerPublicKey: plan.viewerPublicKey,
    })
    return kept
  } catch (error) {
    logger.warn(`[DATAKEY] Automation viewer key backfill failed; access.key unchanged: ${error instanceof Error ? error.message : String(error)}`)
    return credentials
  }
}
