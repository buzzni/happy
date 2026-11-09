import { mkdtemp, mkdir, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GITHUB_WORKTREE_ARCHIVE_RETENTION_MS, pruneGithubWorktreeArchives } from './githubWorktreeArchive'

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
