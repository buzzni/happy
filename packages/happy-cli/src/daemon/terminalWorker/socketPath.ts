/**
 * Where a terminal worker listens (specs/terminal-survive-runner-restart HR1).
 *
 * `sun_path` holds 104 bytes on macOS and 108 on Linux, NUL included, and a happy home under a
 * long dev path overflows it. The socket goes to the first owner-only directory whose full path
 * fits, measured in UTF-8 bytes: `$HAPPY_HOME_DIR/terminal-workers/s`, then `<tmpdir>/happy-<uid>`,
 * then `/tmp/happy-<uid>`. A directory under a shared root is never chmodded — it is used only
 * when it already is, or was just created as, a real directory of this user with mode 0700.
 */
import { lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectory, terminalWorkerDirectory } from './record'

const SOCKET_PATH_BYTE_BUDGET: Partial<Record<NodeJS.Platform, number>> = { darwin: 103, linux: 107 }
const DEFAULT_SOCKET_PATH_BYTE_BUDGET = 103
const OWNER_ONLY_MODE = 0o700

export interface SocketPathInput {
    happyHome: string
    recordId: string
    platform?: NodeJS.Platform
    tmpDir?: string
    uid?: number
}

export class TerminalWorkerSocketPathError extends Error {
    constructor(readonly rejected: Array<{ path: string; reason: string }>) {
        super(`No terminal worker socket path fits: ${rejected.map((entry) => `${entry.path} (${entry.reason})`).join('; ')}`)
        this.name = 'TerminalWorkerSocketPathError'
    }
}

/** The record id without dashes, shortened: unique enough per home, short enough for the budget. */
function socketFileName(recordId: string): string {
    return `tw-${recordId.replace(/-/g, '').slice(0, 16)}.sock`
}

/** Why the directory cannot hold the socket, or null when it is owner-only. */
export function ownerOnlyDirectoryProblem(directory: string, uid: number): string | null {
    const stats = lstatSync(directory)
    if (stats.isSymbolicLink()) return 'is a symlink'
    if (!stats.isDirectory()) return 'is not a directory'
    if (stats.uid !== uid) return `is owned by uid ${stats.uid}`
    if ((stats.mode & 0o777) !== OWNER_ONLY_MODE) return `has mode ${(stats.mode & 0o777).toString(8)}`
    return null
}

function prepareSharedRootDirectory(directory: string, uid: number): string | null {
    try {
        mkdirSync(directory, { mode: OWNER_ONLY_MODE })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return ownerOnlyDirectoryProblem(directory, uid)
}

export function resolveTerminalWorkerSocketPath(input: SocketPathInput): string {
    const platform = input.platform ?? process.platform
    const uid = input.uid ?? process.getuid?.() ?? 0
    const budget = SOCKET_PATH_BYTE_BUDGET[platform] ?? DEFAULT_SOCKET_PATH_BYTE_BUDGET
    const fileName = socketFileName(input.recordId)
    const homeDirectory = join(terminalWorkerDirectory(input.happyHome), 's')
    const candidates: Array<{ directory: string; prepare: () => string | null }> = [
        {
            directory: homeDirectory,
            prepare: () => {
                ensurePrivateDirectory(terminalWorkerDirectory(input.happyHome))
                ensurePrivateDirectory(homeDirectory)
                return ownerOnlyDirectoryProblem(homeDirectory, uid)
            },
        },
        ...[input.tmpDir ?? tmpdir(), '/tmp'].map((root) => {
            const directory = join(root, `happy-${uid}`)
            return { directory, prepare: () => prepareSharedRootDirectory(directory, uid) }
        }),
    ]
    const rejected: Array<{ path: string; reason: string }> = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
        const socketPath = join(candidate.directory, fileName)
        if (seen.has(socketPath)) continue
        seen.add(socketPath)
        const bytes = Buffer.byteLength(socketPath, 'utf8')
        if (bytes > budget) {
            rejected.push({ path: socketPath, reason: `${bytes} bytes > ${budget}` })
            continue
        }
        let problem: string | null
        try {
            problem = candidate.prepare()
        } catch (error) {
            problem = error instanceof Error ? error.message : String(error)
        }
        if (problem) {
            rejected.push({ path: socketPath, reason: problem })
            continue
        }
        return socketPath
    }
    throw new TerminalWorkerSocketPathError(rejected)
}
