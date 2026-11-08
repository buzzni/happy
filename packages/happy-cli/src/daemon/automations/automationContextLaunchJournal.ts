import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { withOwnedFileLock } from '@/utils/ownedFileLock'
import { protectStandaloneObservationDirectory } from '../standaloneLaunchJournal'
import { automationContextLaunchRecordSchema, type AutomationContextLaunchJournal } from './automationContextLaunch'

/** Separate from legacy daemon files so an older CLI cannot reinterpret a pending isolated launch. */
export function createAutomationContextLaunchJournal(home: string): AutomationContextLaunchJournal {
  const directory = join(home, 'automation-context-launches.v1')
  const path = (runId: string) => join(directory, createHash('sha256').update(runId).digest('hex') + '.json')
  async function prepare() {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    await protectStandaloneObservationDirectory(directory)
  }
  async function syncDirectory() {
    if (process.platform === 'win32') return
    for (const target of [directory, home]) {
      const handle = await open(target, constants.O_RDONLY)
      try { await handle.sync() } finally { await handle.close() }
    }
  }
  const privateRecord = (stat: Stats) => stat.isFile() && stat.size <= 1024 * 1024
    && (process.platform === 'win32' || stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600)
  async function openSnapshot(file: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const stat = await handle.stat()
        if (process.platform !== 'win32' && stat.nlink === 0 && privateRecord(stat)) {
          // A protected atomic rename can unlink this opened inode before fstat. Require a distinct
          // owned regular replacement at the same name; never relax the hardlink/symlink guards.
          let replacement: Stats
          try { replacement = await lstat(file) } catch { throw new Error('AUTOMATION_LAUNCH_JOURNAL_UNSAFE') }
          if (privateRecord(replacement) && replacement.nlink === 1 && replacement.dev === stat.dev && replacement.ino !== stat.ino) {
            await handle.close(); continue
          }
        }
        if (!privateRecord(stat) || stat.nlink !== 1) throw new Error('AUTOMATION_LAUNCH_JOURNAL_UNSAFE')
        return handle
      } catch (error) { await handle.close(); throw error }
    }
    throw new Error('AUTOMATION_LAUNCH_JOURNAL_BUSY')
  }
  return {
    async exclusive(runId, work) { await prepare(); return withOwnedFileLock(path(runId) + '.lock', work) },
    async listRunIds() {
      await prepare()
      const runs: string[] = []
      for (const name of (await readdir(directory)).sort()) {
        if (!name.endsWith('.json')) continue
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('AUTOMATION_LAUNCH_JOURNAL_INVALID')
        const file = join(directory, name), handle = await openSnapshot(file)
        try {
          const record = automationContextLaunchRecordSchema.parse(JSON.parse(await handle.readFile('utf8')))
          if (path(record.runId) !== file || runs.includes(record.runId)) throw new Error('AUTOMATION_LAUNCH_JOURNAL_INVALID')
          runs.push(record.runId)
        } finally { await handle.close() }
      }
      return runs
    },
    async read(runId) {
      await prepare()
      let handle
      try { handle = await openSnapshot(path(runId)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      try {
        const record = automationContextLaunchRecordSchema.parse(JSON.parse(await handle.readFile('utf8')))
        if (record.runId !== runId) throw new Error('AUTOMATION_LAUNCH_JOURNAL_INVALID')
        return record
      } finally { await handle.close() }
    },
    async write(raw) {
      const record = automationContextLaunchRecordSchema.parse(raw)
      const text = JSON.stringify(record)
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('AUTOMATION_LAUNCH_JOURNAL_TOO_LARGE')
      await prepare()
      const file = path(record.runId), temporary = file + '.' + randomUUID() + '.tmp'
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(text); await handle.sync(); await handle.close()
        await rename(temporary, file); await syncDirectory()
      } finally {
        await handle.close().catch(() => undefined)
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    },
  }
}
