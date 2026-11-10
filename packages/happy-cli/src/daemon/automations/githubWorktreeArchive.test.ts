import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { restoreMissingManagedWorktree, type RemovedAutomationWorktree } from '../missingWorktreeRestore'
import { removeGithubTriggerWorktree } from './githubTriggerWorktree'
import {
  GITHUB_WORKTREE_ARCHIVE_RETENTION_MS,
  pruneGithubWorktreeArchives,
  restoreArchivedGithubWorktreeChanges,
} from './githubWorktreeArchive'
import { readWorktreeHead, rememberGithubWorktreeRemoval } from './githubWorktreeTombstones'

const execFileAsync = promisify(execFile)

async function fixtureGit(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, encoding: 'utf8' })).stdout
}

describe('pruneGithubWorktreeArchives', () => {
  it('drops archives past the retention window and keeps recent ones', async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), 'happy-worktree-archives-'))
    const now = Date.now()
    try {
      await mkdir(join(archiveRoot, 'old'))
      await mkdir(join(archiveRoot, 'recent'))
      const expired = new Date(now - GITHUB_WORKTREE_ARCHIVE_RETENTION_MS - 60_000)
      await utimes(join(archiveRoot, 'old'), expired, expired)

      await pruneGithubWorktreeArchives(archiveRoot, now)

      expect(await readdir(archiveRoot)).toEqual(['recent'])
    } finally {
      await rm(archiveRoot, { recursive: true, force: true })
    }
  })

  it('does nothing when no archive has been written yet', async () => {
    await expect(pruneGithubWorktreeArchives(join(tmpdir(), 'happy-no-such-archive-root'), Date.now()))
      .resolves.toBeUndefined()
  })
})

describe('restoreArchivedGithubWorktreeChanges', () => {
  it('puts archived changes back when a Chat resumes in the recreated worktree', async () => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'happy-worktree-archive-restore-')))
    const repositoryRoot = join(fixtureRoot, 'repo')
    const worktreePath = join(fixtureRoot, 'automation-worktrees', 'run')
    const archiveTo = join(fixtureRoot, 'archive', 'run')
    const git = (args: string[], cwd = repositoryRoot) => fixtureGit(args, cwd)
    let tombstone: RemovedAutomationWorktree | null = null

    try {
      await mkdir(repositoryRoot)
      await git(['init'])
      await writeFile(join(repositoryRoot, 'a.ts'), 'a\n')
      await git(['add', '.'])
      await git(['commit', '-m', 'base'])
      await git(['worktree', 'add', '--detach', worktreePath, 'HEAD'])
      await writeFile(join(worktreePath, 'a.ts'), 'a\nunfinished fix\n')
      await mkdir(join(worktreePath, 'docs'))
      await writeFile(join(worktreePath, 'docs', 'notes.md'), 'notes\n')

      const discard = rememberGithubWorktreeRemoval(
        (input: { repositoryRoot: string; worktreePath: string }) => removeGithubTriggerWorktree({ ...input, archiveTo }),
        { readHead: readWorktreeHead, record: (removed) => { tombstone = removed } },
      )
      expect(await discard({ repositoryRoot, worktreePath })).toEqual({ ok: true })
      const restored = await restoreMissingManagedWorktree({
        cwd: worktreePath,
        readBranchHint: async () => null,
        findRemovedAutomationWorktree: async () => tombstone,
      })
      expect(restored).toMatchObject({ kind: 'recreated', source: 'recorded-head' })

      expect(await restoreArchivedGithubWorktreeChanges({ archiveFrom: archiveTo, worktreePath })).toBe(true)

      expect(await readFile(join(worktreePath, 'a.ts'), 'utf8')).toBe('a\nunfinished fix\n')
      expect(await readFile(join(worktreePath, 'docs', 'notes.md'), 'utf8')).toBe('notes\n')
      // 되살린 변경은 다시 worktree 에 있다 — 다음 보관과 섞이거나 두 번 얹히지 않게 보관본은 비운다.
      await expect(access(archiveTo)).rejects.toThrow()
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('leaves the worktree alone when no archive was written or it belongs to another commit', async () => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'happy-worktree-archive-mismatch-')))
    const repositoryRoot = join(fixtureRoot, 'repo')
    const archiveTo = join(fixtureRoot, 'archive', 'repo')
    const git = (args: string[], cwd = repositoryRoot) => fixtureGit(args, cwd)

    try {
      await mkdir(repositoryRoot)
      await git(['init'])
      await writeFile(join(repositoryRoot, 'a.ts'), 'a\n')
      await git(['add', '.'])
      await git(['commit', '-m', 'base'])
      expect(await restoreArchivedGithubWorktreeChanges({ archiveFrom: archiveTo, worktreePath: repositoryRoot }))
        .toBe(false)

      await mkdir(archiveTo, { recursive: true })
      await writeFile(join(archiveTo, 'info.json'), JSON.stringify({ worktreePath: repositoryRoot, head: 'b'.repeat(40) }))
      expect(await restoreArchivedGithubWorktreeChanges({ archiveFrom: archiveTo, worktreePath: repositoryRoot }))
        .toBe(false)
      expect(await readdir(archiveTo)).toEqual(['info.json'])
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })
})
