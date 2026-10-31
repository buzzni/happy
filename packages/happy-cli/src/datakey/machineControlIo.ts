/**
 * The file and network side of datakey/machineControl.ts.
 *
 * The pending record holds a machine key, so it is written owner-only and
 * replaced by rename like access.key itself.
 */
import axios from 'axios'
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { configuration } from '@/configuration'
import { buildMachineIdentity } from '@/machineIdentity'
import {
  readMachineIdentity,
  replaceCredentialsDataKey,
  replacePrivateFile,
  updateSettings,
  writeMachineIdentity,
} from '@/persistence'
import { encodeBase64 } from '@/api/encryption'
import { logger } from '@/ui/logger'
import { MachineKeyRotationConflict, parseCompanyKeyRecord, type MachineControlIo } from './machineControl'

export function pendingMachineKeyRotationFile(): string {
  return `${configuration.privateKeyFile}.rotation`
}

/** F8 4-6: the company key this strict machine last moved to on purpose. */
export function companyKeyRecordFile(): string {
  return `${configuration.privateKeyFile}.company`
}

async function readJsonFile(file: string): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    // Unparseable is still a record; the planner discards it.
    return {}
  }
}

export function createMachineControlIo(input: { token: string; machineId: string }): MachineControlIo {
  const file = pendingMachineKeyRotationFile()
  const headers = { Authorization: `Bearer ${input.token}` }
  const machineUrl = `${configuration.serverUrl}/v1/machines/${encodeURIComponent(input.machineId)}`

  return {
    readPending: () => readJsonFile(file),
    writePending: (pending) => replacePrivateFile(file, JSON.stringify(pending, null, 2)),
    deletePending: () => rm(file, { force: true }),
    writeCredentials: async (credentials) => {
      if (credentials.encryption.type !== 'dataKey') throw new Error('only dataKey credentials are replaced here')
      await replaceCredentialsDataKey({
        token: credentials.token,
        publicKey: credentials.encryption.publicKey,
        machineKey: credentials.encryption.machineKey,
        neverEscrowed: credentials.encryption.neverEscrowed === true,
      })
      // A re-login reuses the key recorded here; an old one would no longer
      // open what the server holds.
      try {
        writeMachineIdentity(buildMachineIdentity(input.machineId, credentials, readMachineIdentity()))
      } catch (error) {
        logger.debug('[MACHINE CONTROL] Could not update the machine identity record', error)
      }
    },
    fetchMachine: async () => {
      try {
        const response = await axios.get<{ machine?: { dataEncryptionKey?: string | null; metadataVersion?: number } }>(
          machineUrl, { headers, timeout: 15000 },
        )
        const machine = response.data.machine
        if (!machine) return null
        return { dataEncryptionKey: machine.dataEncryptionKey ?? null, metadataVersion: machine.metadataVersion ?? 0 }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) return null
        throw error
      }
    },
    rotate: async (_machineId, request) => {
      try {
        await axios.post(`${machineUrl}/key-rotation`, request, { headers, timeout: 30000 })
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) throw new MachineKeyRotationConflict()
        throw error
      }
    },
    commitCompanyKey: async ({ publicKey }) => {
      const encoded = encodeBase64(publicKey)
      await updateSettings((settings) => ({ ...settings, accountPublicKey: encoded }))
      // The backup is what `datakey deactivate` restores; it must not bring the old company key back.
      const backupFile = `${configuration.privateKeyFile}.legacy-backup`
      const backup = await readJsonFile(backupFile) as { encryption?: { publicKey?: string } } | null
      if (backup?.encryption && typeof backup.encryption === 'object') {
        await replacePrivateFile(backupFile, JSON.stringify({ ...backup, encryption: { ...backup.encryption, publicKey: encoded } }, null, 2))
      }
    },
    readCompanyKeyRecord: async () => {
      const raw = await readJsonFile(companyKeyRecordFile())
      return raw === null ? null : parseCompanyKeyRecord(raw)
    },
    writeCompanyKeyRecord: (record) => replacePrivateFile(companyKeyRecordFile(), JSON.stringify(record, null, 2)),
    randomKey: () => new Uint8Array(randomBytes(32)),
    now: () => Date.now(),
  }
}
