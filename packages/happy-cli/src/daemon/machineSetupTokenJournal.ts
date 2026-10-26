/** Secret-free recovery intent. Published and fsynced before any selection/claim is sent. */
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { DaemonRotationRequestBodySchema, MachineSetupTokenBindingV2Schema, SessionExecutionCreateBodySchema, HappySessionCreateProofBodySchema, parseCanonicalOrgSetupTokenJson } from '@slopus/happy-wire'
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal'
import { MachineRotationError } from './machineSetupTokenProtocol'
import { formatSetupTokenBinding, readSetupTokenResumeSelection, isMachineSetupTokenBinding, type MachineSetupTokenBindingRecord } from './sessionEnv'

const bindingRecord = z.string().max(8192).refine(raw => {
  try { const parsed = readSetupTokenResumeSelection({ HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: raw }); return !!parsed && isMachineSetupTokenBinding(parsed.binding) } catch { return false }
})
const schema = z.object({ version: z.literal(1), launchId: z.string().min(1).max(128),
  abandoned: z.boolean().optional(), startSubmitted: z.boolean().optional(), current: bindingRecord.optional(), currentOperationId: z.string().min(1).max(128).optional(), pending: z.object({ request: DaemonRotationRequestBodySchema,
    ownershipManaged: z.boolean().optional(), createBody: SessionExecutionCreateBodySchema.optional(), createProofBody: HappySessionCreateProofBodySchema.optional(), machineOwnerAccountId: z.string().min(1).max(128).optional(),
    binding: MachineSetupTokenBindingV2Schema.optional(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    record: bindingRecord.optional(), claimOperationId: z.string(), commitOperationId: z.string(),
  }).strict().optional(),
}).strict()
export type MachineRotationJournalRecord = z.infer<typeof schema>
export type MachineRotationJournal = { list(): Promise<string[]>; read(launchId: string): Promise<MachineRotationJournalRecord | null>; write(record: MachineRotationJournalRecord): Promise<void> }
export function createMachineSetupTokenJournal(home: string): MachineRotationJournal {
  const directory = join(home, 'machine-rotation')
  const path = (id: string) => join(directory, createHash('sha256').update(id).digest('hex') + '.json')
  async function syncDirectory() {
    if (process.platform === 'win32') return
    const handle = await open(directory, constants.O_RDONLY); try { await handle.sync() } finally { await handle.close() }
  }
  async function prepare() {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    await protectStandaloneObservationDirectory(directory)
  }
  return {
    async list() {
      await prepare();
      const ids: string[] = [];
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = await open(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 131072) throw new MachineRotationError('PERSISTENCE_FAILED');
          const record = schema.parse(parseCanonicalOrgSetupTokenJson(await file.readFile('utf8')));
          if (path(record.launchId) !== join(directory, name)) throw new MachineRotationError('PERSISTENCE_FAILED');
          ids.push(record.launchId);
        } finally { await file.close(); }
      }
      return ids;
    },
    async read(launchId) {
      await prepare()
      let file
      try { file = await open(path(launchId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new MachineRotationError('PERSISTENCE_FAILED') }
      try {
        const info = await file.stat()
        if (!info.isFile() || info.nlink !== 1 || info.size > 131072 || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) throw new Error()
        const record = schema.parse(parseCanonicalOrgSetupTokenJson(await file.readFile('utf8')))
        if (record.launchId !== launchId || record.pending?.request.launchId && record.pending.request.launchId !== launchId) throw new Error()
        // A prior rename/directory-sync outcome may be uncertain. Re-reading plus both syncs
        // establishes its ACK before any retry can consume authority or overwrite intent.
        await file.sync(); await syncDirectory()
        return record
      } catch { throw new MachineRotationError('PERSISTENCE_INDETERMINATE') } finally { await file.close() }
    },
    async write(value) {
      const record = schema.parse(value)
      await prepare()
      const temporary = join(directory, randomUUID() + '.tmp'); let published = false
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
        await rename(temporary, path(record.launchId)); published = true
        await syncDirectory()
        if (process.platform !== 'win32') {
          const parent = await open(home, constants.O_RDONLY); try { await parent.sync() } finally { await parent.close() }
        }
      } catch { throw new MachineRotationError(published ? 'PERSISTENCE_INDETERMINATE' : 'PERSISTENCE_FAILED') }
      finally { await unlink(temporary).catch(() => undefined) }
    },
  }
}
export function journalCurrent(record: MachineRotationJournalRecord): MachineSetupTokenBindingRecord | undefined {
  const binding = record.current && readSetupTokenResumeSelection({ HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: record.current })?.binding
  return binding && isMachineSetupTokenBinding(binding) ? binding : undefined
}
export function assertMachineRevision(current: MachineSetupTokenBindingRecord | undefined, next: MachineSetupTokenBindingRecord) {
  if (!current) { if (next.bindingRevision !== 1 || next.previousNonce !== null) throw new MachineRotationError('STALE'); return }
  if (next.launchId !== current.launchId || JSON.stringify(next.execution) !== JSON.stringify(current.execution)
    || next.companyId !== current.companyId || next.machineId !== current.machineId
    || next.bindingRevision !== current.bindingRevision + 1 || next.previousNonce !== current.nonce) throw new MachineRotationError('STALE')
}
export const encodedMachineBinding = formatSetupTokenBinding
