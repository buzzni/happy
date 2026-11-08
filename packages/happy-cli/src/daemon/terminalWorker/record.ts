/**
 * Terminal worker records (specs/terminal-survive-runner-restart HR1·HR10): happy's ledger of
 * the workers a daemon started. One owner-only JSON file per worker under
 * `$HAPPY_HOME_DIR/terminal-workers/`, written by the worker alone, read by every daemon that
 * starts afterwards to adopt or retire it.
 *
 * A record holds the socket secret, the same trust level as the daemon state file's control
 * secret: anyone who can read it is already the user.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

const TerminalWorkerRecordSchema = z.object({
    recordId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    pid: z.number().int().positive(),
    /** Epoch ms from `ps -o lstart=` of the worker itself; null when the platform would not say. */
    startedAt: z.number().nullable(),
    bootId: z.string().nullable(),
    socketPath: z.string().min(1),
    secret: z.string().min(1),
    // Read loosely: a version this daemon does not speak is an incompatible worker, not a broken record.
    protocolVersion: z.union([z.number(), z.string()]),
    cliVersion: z.string(),
    createdAt: z.number(),
})

export type TerminalWorkerRecord = z.infer<typeof TerminalWorkerRecordSchema>

export type TerminalWorkerRecordFile =
    | { path: string; record: TerminalWorkerRecord }
    | { path: string; error: Error }

export function terminalWorkerDirectory(happyHome: string): string {
    return join(happyHome, 'terminal-workers')
}

export function terminalWorkerRecordPath(happyHome: string, recordId: string): string {
    return join(terminalWorkerDirectory(happyHome), `${recordId}.json`)
}

export function terminalWorkerLogPath(happyHome: string): string {
    return join(happyHome, 'logs', 'terminal-worker.log')
}

export function newTerminalWorkerRecordId(): string {
    return randomUUID()
}

/** Creates the directory owner-only, or tightens one this user owns. Never follows a symlink. */
export function ensurePrivateDirectory(directory: string): void {
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
    if (process.platform === 'win32') return
    const stats = lstatSync(directory)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${directory} is not a directory`)
    if (stats.uid !== process.getuid?.()) throw new Error(`${directory} belongs to another user`)
    if ((stats.mode & 0o777) !== PRIVATE_DIR_MODE) chmodSync(directory, PRIVATE_DIR_MODE)
}

/** Atomic: a reader sees the previous record or this one, never half of one. */
export function writeTerminalWorkerRecord(happyHome: string, record: TerminalWorkerRecord): string {
    const directory = terminalWorkerDirectory(happyHome)
    ensurePrivateDirectory(directory)
    const target = terminalWorkerRecordPath(happyHome, TerminalWorkerRecordSchema.parse(record).recordId)
    const tmp = `${target}.${process.pid}.tmp`
    rmSync(tmp, { force: true })
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' })
    renameSync(tmp, target)
    return target
}

export function readTerminalWorkerRecord(path: string): TerminalWorkerRecord {
    return TerminalWorkerRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** Every record in the home; one that cannot be read is listed with its error, never dropped. */
export function listTerminalWorkerRecords(happyHome: string): TerminalWorkerRecordFile[] {
    const directory = terminalWorkerDirectory(happyHome)
    let names: string[]
    try {
        names = readdirSync(directory)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        return [{ path: directory, error: error instanceof Error ? error : new Error(String(error)) }]
    }
    const files: TerminalWorkerRecordFile[] = []
    for (const name of names.sort()) {
        if (!name.endsWith('.json')) continue
        const path = join(directory, name)
        try {
            files.push({ path, record: readTerminalWorkerRecord(path) })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            files.push({ path, error: error instanceof Error ? error : new Error(String(error)) })
        }
    }
    return files
}

/**
 * Deletes a record and its socket, unless the file now names another worker (or cannot be read
 * to tell). Returns whether the record was removed.
 */
export function retireTerminalWorkerRecord(happyHome: string, record: TerminalWorkerRecord): boolean {
    const path = terminalWorkerRecordPath(happyHome, record.recordId)
    try {
        if (readTerminalWorkerRecord(path).recordId !== record.recordId) return false
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    rmSync(path, { force: true })
    if (process.platform !== 'win32') rmSync(record.socketPath, { force: true })
    return true
}
