/**
 * Who the running daemon is (aplus specs/codexcli-daemon-restart-drain R18·R19).
 *
 * A pid alone is not an identity: after a crash, logoff or reboot the same
 * number is handed to an unrelated process, and signalling it on the daemon's
 * behalf kills a stranger. The state file therefore records the daemon's own
 * process start time (read once at boot — never on the shutdown path) and the
 * kernel boot id, and every path that signals a daemon compares them first.
 *
 * The bundle digest lets the heartbeat tell a real replacement of
 * `dist/index.mjs` from a reinstall that only touched the mtime.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { getProcessStartedAt, getWindowsProcessStartedAt } from '@/utils/processStartTime'
import { readCurrentBootIdSync } from '@/utils/bootIdentity'
import { isPidAlive as defaultIsPidAlive } from '@/persistence'

export interface ExecutableDigest {
    path: string
    size: number
    mtimeMs: number
    sha256: string
}

export interface DaemonIdentity {
    pid: number
    /** Epoch ms the daemon process started; absent when the platform did not answer. */
    startedAt?: number
    /** darwin/linux boot identity; never recorded on Windows. */
    bootId?: string
    executable?: ExecutableDigest
}

/** `ps` reports whole seconds and clocks get stepped; Windows CIM is exact. */
const POSIX_START_SLACK_MS = 1_000

function sha256Of(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function readExecutableDigest(path: string): ExecutableDigest | undefined {
    try {
        const { size, mtimeMs } = statSync(path)
        return { path, size, mtimeMs, sha256: sha256Of(path) }
    } catch {
        return undefined
    }
}

/**
 * Hashes only when size or mtime moved. A rewrite with identical bytes moves
 * the baseline forward so the next heartbeat does not hash it again.
 */
export function checkExecutableReplaced(
    baseline: ExecutableDigest,
    deps: { hash?: (path: string) => string } = {},
): { replaced: boolean; baseline: ExecutableDigest } {
    let size: number
    let mtimeMs: number
    try {
        ({ size, mtimeMs } = statSync(baseline.path))
    } catch {
        // Missing mid-install: decide on a later heartbeat.
        return { replaced: false, baseline }
    }
    if (size === baseline.size && mtimeMs === baseline.mtimeMs) return { replaced: false, baseline }
    let sha256: string
    try {
        sha256 = (deps.hash ?? sha256Of)(baseline.path)
    } catch {
        return { replaced: false, baseline }
    }
    if (sha256 === baseline.sha256) return { replaced: false, baseline: { ...baseline, size, mtimeMs } }
    return { replaced: true, baseline }
}

export function buildDaemonIdentity(input: {
    pid: number
    readStartedAt: (pid: number) => number | undefined
    readBootId: () => string | undefined
    executable: ExecutableDigest | undefined
}): DaemonIdentity {
    const startedAt = input.readStartedAt(input.pid)
    const bootId = input.readBootId()
    return {
        pid: input.pid,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(bootId ? { bootId } : {}),
        ...(input.executable ? { executable: input.executable } : {}),
    }
}

/** Identity of this daemon process, built once at boot. */
export async function readOwnDaemonIdentity(executablePath: string): Promise<DaemonIdentity> {
    const startedAt = process.platform === 'win32'
        ? await getWindowsProcessStartedAt(process.pid)
        : getProcessStartedAt(process.pid)
    return buildDaemonIdentity({
        pid: process.pid,
        readStartedAt: () => startedAt,
        readBootId: () => readCurrentBootIdSync(),
        executable: readExecutableDigest(executablePath),
    })
}

export type DaemonIdentityVerdict = 'match' | 'mismatch' | 'dead' | 'unknown'

/**
 * Whether `recorded` still names a live process. Only `match` permits a signal:
 * `mismatch` means the pid now belongs to someone else (treat the state as
 * stale), `unknown` means it cannot be proven either way.
 */
export async function verifyDaemonIdentity(
    recorded: DaemonIdentity,
    deps: {
        isPidAlive?: (pid: number) => boolean
        readStartedAt?: (pid: number) => number | undefined | Promise<number | undefined>
        readBootId?: () => string | undefined
        platform?: NodeJS.Platform
    } = {},
): Promise<DaemonIdentityVerdict> {
    const platform = deps.platform ?? process.platform
    if (!(deps.isPidAlive ?? defaultIsPidAlive)(recorded.pid)) return 'dead'
    const currentBootId = (deps.readBootId ?? readCurrentBootIdSync)()
    if (recorded.bootId && currentBootId && recorded.bootId !== currentBootId) return 'mismatch'
    if (recorded.startedAt === undefined) return 'unknown'
    const readStartedAt = deps.readStartedAt
        ?? (platform === 'win32' ? getWindowsProcessStartedAt : getProcessStartedAt)
    const liveStartedAt = await readStartedAt(recorded.pid)
    if (liveStartedAt === undefined) return 'unknown'
    const slack = platform === 'win32' ? 0 : POSIX_START_SLACK_MS
    return Math.abs(liveStartedAt - recorded.startedAt) <= slack ? 'match' : 'mismatch'
}
