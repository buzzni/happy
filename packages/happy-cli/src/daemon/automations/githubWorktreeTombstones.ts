import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import type { RemovedAutomationWorktree } from '../missingWorktreeRestore'

/*
 * The daemon removes a GitHub-triggered run's worktree once its run-once
 * session exits, but the Chat it ran in stays open and the user can reply.
 * Resume then needs the same directory back, and nothing in
 * `automation-worktrees/<hash>` says which repository it came from or which
 * commit it was on — `git worktree remove` erases git's own record of it.
 * This file keeps that record so missingWorktreeRestore can put it back.
 */

const RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_ENTRIES = 500
const execFileAsync = promisify(execFile)

interface Tombstone extends RemovedAutomationWorktree {
  removedAt: number
}

export interface GithubWorktreeTombstoneStore {
  record(removed: RemovedAutomationWorktree): void
  /** The removed worktree that is, or contains, `directory`. */
  find(directory: string): RemovedAutomationWorktree | null
}

function isTombstone(value: unknown): value is Tombstone {
  const row = value as Partial<Tombstone> | null
  return typeof row === 'object' && row !== null
    && typeof row.repositoryRoot === 'string'
    && typeof row.worktreePath === 'string'
    && typeof row.headSha === 'string'
    && typeof row.removedAt === 'number'
}

export function createGithubWorktreeTombstoneStore(options: {
  filePath: string
  now?: () => number
  maxEntries?: number
}): GithubWorktreeTombstoneStore {
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries ?? MAX_ENTRIES

  // Losing these only costs a later resume, so an unreadable file reads as empty.
  const read = (): Tombstone[] => {
    try {
      const entries = (JSON.parse(readFileSync(options.filePath, 'utf8')) as { entries?: unknown }).entries
      return Array.isArray(entries) ? entries.filter(isTombstone) : []
    } catch {
      return []
    }
  }

  const live = (entries: Tombstone[]) => entries.filter((entry) => now() - entry.removedAt < RETENTION_MS)

  return {
    record(removed) {
      const worktreePath = resolve(removed.worktreePath)
      const entries = [
        ...live(read()).filter((entry) => resolve(entry.worktreePath) !== worktreePath),
        { repositoryRoot: removed.repositoryRoot, worktreePath, headSha: removed.headSha, removedAt: now() },
      ].slice(-maxEntries)
      mkdirSync(dirname(options.filePath), { recursive: true })
      const tmp = `${options.filePath}.${process.pid}.${now()}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, options.filePath)
      chmodSync(options.filePath, 0o600)
    },
    find(directory) {
      const target = resolve(directory)
      const match = live(read()).reverse().find((entry) => {
        const inside = relative(resolve(entry.worktreePath), target)
        return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
      })
      return match
        ? { repositoryRoot: match.repositoryRoot, worktreePath: match.worktreePath, headSha: match.headSha }
        : null
    },
  }
}

type Removal = { ok: true } | { ok: false; dirty: boolean; error: string }

/** Wraps the daemon's worktree removal so a removed worktree can later be put back. */
export function rememberGithubWorktreeRemoval<Input extends { repositoryRoot: string; worktreePath: string }>(
  remove: (input: Input) => Promise<Removal>,
  deps: {
    readHead: (worktreePath: string) => Promise<string | null>
    record: (removed: RemovedAutomationWorktree) => void
  },
): (input: Input) => Promise<Removal> {
  return async (input) => {
    const headSha = await deps.readHead(input.worktreePath).catch(() => null)
    const result = await remove(input)
    if (result.ok && headSha) {
      try {
        deps.record({ repositoryRoot: input.repositoryRoot, worktreePath: input.worktreePath, headSha })
      } catch {
        // The removal itself succeeded; only a later resume of this Chat is lost.
      }
    }
    return result
  }
}

export async function readWorktreeHead(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const sha = stdout.trim().toLowerCase()
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}
