/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R4/R5 — the machine key
 * the server may not hold.
 *
 * Compat, the default, registers as before: the server receives the machine
 * key wrapped to its own key, and with it every daemon RPC. Strict withholds
 * it, and first replaces any key the server may already hold. Only a key
 * generated here under strict, and recorded as never escrowed next to the key
 * in access.key, is kept. The server is not asked whether it holds a copy: a
 * server that kept one would say it had none.
 *
 * A replacement survives a crash at any point. The new key and its envelopes
 * are recorded in a pending file before the server sees them, the server swap
 * succeeds again when repeated, access.key is replaced in one rename only after
 * the swap, and the pending record is removed last. The next start resumes
 * whatever was left.
 *
 * F8 (specs/e2ee-machine-control-boundary datakey-reseed-strict-design.md):
 * reseedCompanyKey moves a strict machine to a new company key the same way,
 * with a new machine key wrapped only to that company key. Its pending record
 * (version 2) also names the company key and the server envelope it started
 * from, and stays until every local file names the new key.
 *
 * settleMachineControl decides; MachineControlIo does the file and network
 * work, so every path here runs without either.
 */
import { createHash } from 'node:crypto'
import * as z from 'zod'
import { buildMachineKeyEnvelopes, decodeBase64, encodeBase64, encrypt } from '@/api/encryption'
import type { MachineMetadata } from '@/api/types'
import type { Credentials } from '@/persistence'

export type MachineControlMode = 'compat' | 'strict'

type DataKeyEncryption = Extract<Credentials['encryption'], { type: 'dataKey' }>

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const pendingFields = {
  machineId: z.string().min(1),
  /** sha256 (hex) of the machine key this rotation replaces. */
  fromKeySha256: sha256Hex,
  machineKey: z.string().base64(),
  dataEncryptionKey: z.string().min(1),
  serverRpcKeyEnvelope: z.string().min(1).nullable(),
  lastError: z.string().optional(),
  lastAttemptAt: z.number().optional(),
}
const pendingSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...pendingFields }),
  z.object({
    version: z.literal(2),
    ...pendingFields,
    reseed: z.object({
      /** The company public key (base64) the new machine key is wrapped to. */
      publicKey: z.string().base64(),
      generation: z.number().int().positive(),
      /** sha256 (hex) of the server envelope the swap may replace, and no other. */
      fromEnvelopeSha256: sha256Hex,
    }),
  }),
])
export type PendingMachineKeyRotation = z.infer<typeof pendingSchema>
type PendingCompanyKeyReseed = Extract<PendingMachineKeyRotation, { version: 2 }>

const companyKeyRecordSchema = z.object({
  version: z.literal(1),
  /** sha256 (hex) of the company public key access.key wraps new session keys to. */
  publicKeySha256: sha256Hex,
  /** Null for a key recorded before any signed generation reached this machine. */
  generation: z.number().int().positive().nullable(),
})
/** The company key a strict machine last moved to on purpose (F8 4-6). */
export type CompanyKeyRecord = z.infer<typeof companyKeyRecordSchema>

export function parseCompanyKeyRecord(raw: unknown): CompanyKeyRecord | null {
  const parsed = companyKeyRecordSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The company key a reseed moves to, from a declaration the caller has verified. */
export type CompanyKeyTarget = { publicKey: Uint8Array; generation: number }

export function parsePendingMachineKeyRotation(raw: unknown): PendingMachineKeyRotation | null {
  const parsed = pendingSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** What the rotation needs from the server's machine record. */
export type ServerMachineKeyState = { dataEncryptionKey: string | null; metadataVersion: number }

/** Body of POST /v1/machines/:id/key-rotation. It never carries a machine key envelope for the server. */
export type MachineKeyRotationRequest = {
  expectedDataEncryptionKey: string
  dataEncryptionKey: string
  serverRpcKeyEnvelope: string | null
  metadata: string
  expectedMetadataVersion: number
  daemonState: null
}

export interface MachineControlIo {
  readPending(): Promise<unknown | null>
  writePending(pending: PendingMachineKeyRotation): Promise<void>
  deletePending(): Promise<void>
  /** Replaces access.key in one rename. */
  writeCredentials(credentials: Credentials): Promise<void>
  /** Null when the server has no such machine for this account; throws when it cannot tell. */
  fetchMachine(machineId: string): Promise<ServerMachineKeyState | null>
  /** Throws MachineKeyRotationConflict when the server's record moved since it was read. */
  rotate(machineId: string, request: MachineKeyRotationRequest): Promise<void>
  /** Points settings.json and the legacy backup at the company key access.key now uses. */
  commitCompanyKey(target: CompanyKeyTarget): Promise<void>
  readCompanyKeyRecord(): Promise<CompanyKeyRecord | null>
  writeCompanyKeyRecord(record: CompanyKeyRecord): Promise<void>
  randomKey(): Uint8Array
  now(): number
}

export class MachineKeyRotationConflict extends Error {
  constructor() {
    super('The machine record changed while its key was being replaced')
    this.name = 'MachineKeyRotationConflict'
  }
}

export class StrictMachineControlError extends Error {
  constructor(
    readonly reason: 'requires-datakey' | 'rotation-failed' | 'company-key-changed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'StrictMachineControlError'
  }
}

export class CompanyKeyReseedError extends Error {
  constructor(
    readonly code: 'NOT_STRICT' | 'STALE_GENERATION' | 'BUSY' | 'NO_SERVER_ENVELOPE' | 'ENVELOPE_CHANGED',
    message: string,
  ) {
    super(message)
    this.name = 'CompanyKeyReseedError'
  }
}

/** The server may already hold the new envelope; only the next start's resume settles which key holds. */
export class CompanyKeyReseedUnsettledError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CompanyKeyReseedUnsettledError'
  }
}

/** Attempts at the swap when the record keeps moving underneath it. */
const ROTATION_ATTEMPTS = 3

const keySha256 = (key: Uint8Array | string) => createHash('sha256').update(key).digest('hex')
const recordFor = (publicKey: Uint8Array, generation: number | null): CompanyKeyRecord =>
  ({ version: 1, publicKeySha256: keySha256(publicKey), generation })

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function withKey(credentials: Credentials, encryption: DataKeyEncryption, machineKey: Uint8Array, neverEscrowed: boolean): Credentials {
  return {
    token: credentials.token,
    encryption: {
      type: 'dataKey',
      publicKey: encryption.publicKey,
      machineKey,
      ...(neverEscrowed ? { neverEscrowed: true as const } : {}),
    },
  }
}

/**
 * The credentials this daemon registers and serves RPC with. Throws
 * StrictMachineControlError when strict mode cannot be put in force, so a
 * daemon never comes up on a key the server may hold while strict is on.
 */
type SettleInput = {
  mode: MachineControlMode
  credentials: Credentials
  machineId: string
  /** The server service key (base64) registration wraps to, if configured. */
  serverPublicKey: string | null
  /** Re-encrypted under the new key in place of whatever the server stored under the old one. */
  metadata: MachineMetadata
  io: MachineControlIo
}

export async function settleMachineControl(input: SettleInput): Promise<Credentials> {
  const settled = await settleMachineKey(input)
  if (input.mode === 'strict' && settled.encryption.type === 'dataKey') {
    await checkCompanyKeyRecord(input.io, settled.encryption.publicKey)
  }
  return settled
}

/**
 * F8 4-6: a strict machine wraps session keys only to a company key it moved
 * to through a reseed (or held when this record was first written). A key
 * swapped into access.key some other way stops the daemon.
 */
async function checkCompanyKeyRecord(io: MachineControlIo, publicKey: Uint8Array): Promise<void> {
  const record = await io.readCompanyKeyRecord()
  if (record === null) {
    await io.writeCompanyKeyRecord(recordFor(publicKey, null))
    return
  }
  if (record.publicKeySha256 !== keySha256(publicKey)) {
    throw new StrictMachineControlError(
      'company-key-changed',
      'access.key holds a company key this machine did not move to through a reseed',
    )
  }
}

async function settleMachineKey(input: SettleInput): Promise<Credentials> {
  const { mode, credentials, machineId, io } = input
  const encryption = credentials.encryption
  if (encryption.type !== 'dataKey') {
    if (mode === 'strict') {
      throw new StrictMachineControlError(
        'requires-datakey',
        'Strict machine control needs dataKey credentials; this machine key is the account secret',
      )
    }
    return credentials
  }

  const claimed = await claimPending(io, machineId, encryption.machineKey)
  if (claimed?.pending.version === 2) {
    return resumeReseed(input, credentials, claimed.pending, claimed.committed)
  }
  const pending = claimed?.pending.version === 1 ? claimed.pending : null
  if (!pending && (mode === 'compat' || encryption.neverEscrowed)) {
    // Compat registration wraps the key for the server again, so the mark
    // would no longer be true by the time anyone read it.
    if (mode === 'compat' && encryption.neverEscrowed && input.serverPublicKey) {
      const marked = withKey(credentials, encryption, encryption.machineKey, false)
      await io.writeCredentials(marked)
      return marked
    }
    return credentials
  }

  const rotation = pending ?? await startRotation(input, encryption)
  try {
    await swapOnServer(input, rotation)
    const replaced = withKey(credentials, encryption, decodeBase64(rotation.machineKey), mode === 'strict')
    await io.writeCredentials(replaced)
    await io.deletePending()
    return replaced
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await io.writePending({ ...rotation, lastError: message, lastAttemptAt: io.now() }).catch(() => {})
    if (mode === 'strict') {
      throw new StrictMachineControlError('rotation-failed', `Could not replace the machine key: ${message}`, { cause: error })
    }
    // Compat can serve on the current key; the next start tries again.
    return credentials
  }
}

/**
 * The pending rotation that continues from `currentKey`, or null. A record
 * for another machine or key is removed, and so is a harden rotation already
 * promoted into access.key. A reseed promoted into access.key is kept
 * (`committed`): settings, backup and the company key record come after it.
 */
async function claimPending(
  io: MachineControlIo,
  machineId: string,
  currentKey: Uint8Array,
): Promise<{ pending: PendingMachineKeyRotation; committed: boolean } | null> {
  const raw = await io.readPending()
  if (raw === null) return null
  const pending = parsePendingMachineKeyRotation(raw)
  if (pending && pending.machineId === machineId) {
    const promoted = sameKey(decodeBase64(pending.machineKey), currentKey)
    if (pending.version === 2 && promoted) return { pending, committed: true }
    if (pending.fromKeySha256 === keySha256(currentKey) && !promoted) return { pending, committed: false }
  }
  await io.deletePending()
  return null
}

async function resumeReseed(
  input: SettleInput,
  credentials: Credentials,
  pending: PendingCompanyKeyReseed,
  committed: boolean,
): Promise<Credentials> {
  if (committed) {
    await finishReseed(input.io, pending)
    return credentials
  }
  try {
    await swapReseed(input, pending)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await input.io.writePending({ ...pending, lastError: message, lastAttemptAt: input.io.now() }).catch(() => {})
    throw new StrictMachineControlError('rotation-failed', `Could not finish the company key reseed: ${message}`, { cause: error })
  }
  return commitReseed(input.io, credentials, pending)
}

/**
 * F8: moves this strict machine to `target`, a company key the caller has
 * already verified. A new machine key, wrapped only to `target`, replaces the
 * old one on the server first, then in access.key; anyone who learned the old
 * machine key through the old company key can no longer reach the machine.
 */
export async function reseedCompanyKey(input: {
  credentials: Credentials
  machineId: string
  serverPublicKey: string | null
  metadata: MachineMetadata
  io: MachineControlIo
  target: CompanyKeyTarget
}): Promise<{ credentials: Credentials; changed: boolean; machineKey: Uint8Array }> {
  const { credentials, machineId, io, target } = input
  const encryption = credentials.encryption
  if (encryption.type !== 'dataKey' || !encryption.neverEscrowed) {
    throw new CompanyKeyReseedError('NOT_STRICT', 'Only a machine under strict machine control moves to a company key here')
  }
  if (sameKey(encryption.publicKey, target.publicKey)) {
    await io.commitCompanyKey(target)
    await io.writeCompanyKeyRecord(recordFor(target.publicKey, target.generation))
    return { credentials, changed: false, machineKey: encryption.machineKey }
  }
  const record = await io.readCompanyKeyRecord()
  if (record?.generation != null && target.generation <= record.generation) {
    throw new CompanyKeyReseedError('STALE_GENERATION', `Generation ${target.generation} is not newer than ${record.generation}`)
  }
  if (await io.readPending() !== null) {
    throw new CompanyKeyReseedError('BUSY', 'Another machine key replacement has not finished')
  }
  const current = await io.fetchMachine(machineId)
  if (!current?.dataEncryptionKey) {
    throw new CompanyKeyReseedError('NO_SERVER_ENVELOPE', 'The server holds no machine key envelope for this machine')
  }
  const machineKey = io.randomKey()
  const envelopes = buildMachineKeyEnvelopes(
    { machineKey, accountPublicKey: target.publicKey },
    input.serverPublicKey ? decodeBase64(input.serverPublicKey) : null,
    { escrowMachineKey: false },
  )
  const pending: PendingCompanyKeyReseed = {
    version: 2,
    machineId,
    fromKeySha256: keySha256(encryption.machineKey),
    machineKey: encodeBase64(machineKey),
    dataEncryptionKey: encodeBase64(envelopes.dataEncryptionKey!),
    serverRpcKeyEnvelope: envelopes.serverRpcKeyEnvelope ? encodeBase64(envelopes.serverRpcKeyEnvelope) : null,
    reseed: {
      publicKey: encodeBase64(target.publicKey),
      generation: target.generation,
      fromEnvelopeSha256: keySha256(current.dataEncryptionKey),
    },
  }
  await io.writePending(pending)
  try {
    await swapReseed(input, pending)
  } catch (error) {
    // Forget the attempt only when the server is known not to hold the new envelope.
    const after = await io.fetchMachine(machineId).catch(() => undefined)
    if (after !== undefined && after?.dataEncryptionKey !== pending.dataEncryptionKey) {
      await io.deletePending()
      throw error
    }
    if (after === undefined) {
      throw new CompanyKeyReseedUnsettledError(`Could not tell whether the server took the new machine key: ${errorMessage(error)}`, { cause: error })
    }
  }
  try {
    return { credentials: await commitReseed(io, credentials, pending), changed: true, machineKey }
  } catch (error) {
    throw new CompanyKeyReseedUnsettledError(`The server took the new machine key but this machine did not: ${errorMessage(error)}`, { cause: error })
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Swaps only the envelope the reseed started from; a third value means someone else moved it. */
async function swapReseed(
  input: { machineId: string; metadata: MachineMetadata; io: MachineControlIo },
  pending: PendingCompanyKeyReseed,
): Promise<void> {
  const metadata = encodeBase64(encrypt(decodeBase64(pending.machineKey), 'dataKey', input.metadata))
  for (let attempt = 1; ; attempt++) {
    const current = await input.io.fetchMachine(input.machineId)
    if (current === null) throw new Error('The server has no record of this machine')
    if (current.dataEncryptionKey === pending.dataEncryptionKey) return
    if (!current.dataEncryptionKey || keySha256(current.dataEncryptionKey) !== pending.reseed.fromEnvelopeSha256) {
      throw new CompanyKeyReseedError('ENVELOPE_CHANGED', 'The server holds a machine key envelope this reseed did not start from')
    }
    try {
      await input.io.rotate(input.machineId, {
        expectedDataEncryptionKey: current.dataEncryptionKey,
        dataEncryptionKey: pending.dataEncryptionKey,
        serverRpcKeyEnvelope: pending.serverRpcKeyEnvelope,
        metadata,
        expectedMetadataVersion: current.metadataVersion,
        daemonState: null,
      })
      return
    } catch (error) {
      if (!(error instanceof MachineKeyRotationConflict) || attempt >= ROTATION_ATTEMPTS) throw error
    }
  }
}

async function commitReseed(io: MachineControlIo, credentials: Credentials, pending: PendingCompanyKeyReseed): Promise<Credentials> {
  const replaced: Credentials = {
    token: credentials.token,
    encryption: {
      type: 'dataKey',
      publicKey: decodeBase64(pending.reseed.publicKey),
      machineKey: decodeBase64(pending.machineKey),
      neverEscrowed: true,
    },
  }
  await io.writeCredentials(replaced)
  await finishReseed(io, pending)
  return replaced
}

/** The steps after access.key; the pending record goes only once all of them are done. */
async function finishReseed(io: MachineControlIo, pending: PendingCompanyKeyReseed): Promise<void> {
  const publicKey = decodeBase64(pending.reseed.publicKey)
  await io.commitCompanyKey({ publicKey, generation: pending.reseed.generation })
  await io.writeCompanyKeyRecord(recordFor(publicKey, pending.reseed.generation))
  await io.deletePending()
}

async function startRotation(
  input: { machineId: string; serverPublicKey: string | null; io: MachineControlIo },
  encryption: DataKeyEncryption,
): Promise<PendingMachineKeyRotation> {
  const machineKey = input.io.randomKey()
  const envelopes = buildMachineKeyEnvelopes(
    { machineKey, accountPublicKey: encryption.publicKey },
    input.serverPublicKey ? decodeBase64(input.serverPublicKey) : null,
    { escrowMachineKey: false },
  )
  const pending: PendingMachineKeyRotation = {
    version: 1,
    machineId: input.machineId,
    fromKeySha256: keySha256(encryption.machineKey),
    machineKey: encodeBase64(machineKey),
    dataEncryptionKey: encodeBase64(envelopes.dataEncryptionKey!),
    serverRpcKeyEnvelope: envelopes.serverRpcKeyEnvelope ? encodeBase64(envelopes.serverRpcKeyEnvelope) : null,
  }
  await input.io.writePending(pending)
  return pending
}

/** Swaps the server's envelopes for the pending ones; a machine the server does not have needs no swap. */
async function swapOnServer(
  input: { machineId: string; metadata: MachineMetadata; io: MachineControlIo },
  rotation: PendingMachineKeyRotation,
): Promise<void> {
  const metadata = encodeBase64(encrypt(decodeBase64(rotation.machineKey), 'dataKey', input.metadata))
  for (let attempt = 1; ; attempt++) {
    const current = await input.io.fetchMachine(input.machineId)
    if (current === null) return
    if (!current.dataEncryptionKey) {
      throw new Error('The server holds no account envelope for this machine')
    }
    try {
      await input.io.rotate(input.machineId, {
        expectedDataEncryptionKey: current.dataEncryptionKey,
        dataEncryptionKey: rotation.dataEncryptionKey,
        serverRpcKeyEnvelope: rotation.serverRpcKeyEnvelope,
        metadata,
        expectedMetadataVersion: current.metadataVersion,
        daemonState: null,
      })
      return
    } catch (error) {
      if (!(error instanceof MachineKeyRotationConflict) || attempt >= ROTATION_ATTEMPTS) throw error
    }
  }
}
