import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createGithubWorktreeTombstoneStore,
  rememberGithubWorktreeRemoval,
} from './githubWorktreeTombstones'

const garbage: string[] = []
afterEach(async () => {
  await Promise.all(garbage.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function storeFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'worktree-tombstones-'))
  garbage.push(dir)
  return join(dir, 'tombstones.json')
}

const SHA = 'a'.repeat(40)
const DAY = 24 * 60 * 60_000

describe('createGithubWorktreeTombstoneStore', () => {
  it('finds the removed worktree that contains a session directory', async () => {
    const store = createGithubWorktreeTombstoneStore({ filePath: await storeFile(), now: () => 1_000 })
    store.record({ repositoryRoot: '/repo', worktreePath: '/happy/automation-worktrees/abc', headSha: SHA })

    const expected = { repositoryRoot: '/repo', worktreePath: '/happy/automation-worktrees/abc', headSha: SHA }
    expect(store.find('/happy/automation-worktrees/abc')).toEqual(expected)
    expect(store.find('/happy/automation-worktrees/abc/packages/web')).toEqual(expected)
    expect(store.find('/happy/automation-worktrees/abcdef')).toBeNull()
  })

  it('survives a daemon restart', async () => {
    const filePath = await storeFile()
    createGithubWorktreeTombstoneStore({ filePath, now: () => 1_000 })
      .record({ repositoryRoot: '/repo', worktreePath: '/wt/a', headSha: SHA })

    expect(createGithubWorktreeTombstoneStore({ filePath, now: () => 2_000 }).find('/wt/a'))
      .toMatchObject({ headSha: SHA })
  })

  it('keeps only the latest record for a path that is removed again', async () => {
    const filePath = await storeFile()
    const store = createGithubWorktreeTombstoneStore({ filePath, now: () => 1_000 })
    store.record({ repositoryRoot: '/repo', worktreePath: '/wt/a', headSha: SHA })
    store.record({ repositoryRoot: '/repo', worktreePath: '/wt/a', headSha: 'b'.repeat(40) })

    expect(store.find('/wt/a')?.headSha).toBe('b'.repeat(40))
    expect(JSON.parse(await readFile(filePath, 'utf8')).entries).toHaveLength(1)
  })

  it('forgets records past the retention window and beyond the size cap', async () => {
    const filePath = await storeFile()
    let now = 0
    const store = createGithubWorktreeTombstoneStore({ filePath, now: () => now, maxEntries: 2 })
    store.record({ repositoryRoot: '/repo', worktreePath: '/wt/old', headSha: SHA })
    now = 31 * DAY
    store.record({ repositoryRoot: '/repo', worktreePath: '/wt/b', headSha: SHA })
    store.record({ repositoryRoot: '/repo', worktreePath: '/wt/c', headSha: SHA })
    store.record({ repositoryRoot: '/repo', worktreePath: '/wt/d', headSha: SHA })

    expect(store.find('/wt/old')).toBeNull()
    expect(store.find('/wt/b')).toBeNull()
    expect(store.find('/wt/c')).not.toBeNull()
    expect(store.find('/wt/d')).not.toBeNull()
  })

  it('treats an unreadable file as empty and replaces it on the next record', async () => {
    const filePath = await storeFile()
    await writeFile(filePath, '{not json')
    const store = createGithubWorktreeTombstoneStore({ filePath, now: () => 1_000 })

    expect(store.find('/wt/a')).toBeNull()
    store.record({ repositoryRoot: '/repo', worktreePath: '/wt/a', headSha: SHA })
    expect(store.find('/wt/a')).not.toBeNull()
  })
})

describe('rememberGithubWorktreeRemoval', () => {
  it('records the HEAD read before a successful removal', async () => {
    const order: string[] = []
    const record = vi.fn(() => { order.push('record') })
    const remove = rememberGithubWorktreeRemoval(async () => { order.push('remove'); return { ok: true } }, {
      readHead: async () => { order.push('readHead'); return SHA },
      record,
    })

    const result = await remove({ repositoryRoot: '/repo', worktreePath: '/wt/a' })

    expect(result).toEqual({ ok: true })
    expect(order).toEqual(['readHead', 'remove', 'record'])
    expect(record).toHaveBeenCalledWith({ repositoryRoot: '/repo', worktreePath: '/wt/a', headSha: SHA })
  })

  it('records nothing when the removal kept the worktree', async () => {
    const record = vi.fn()
    const remove = rememberGithubWorktreeRemoval(
      async () => ({ ok: false, dirty: true, error: 'dirty' }),
      { readHead: async () => SHA, record },
    )

    expect(await remove({ repositoryRoot: '/repo', worktreePath: '/wt/a' })).toMatchObject({ ok: false })
    expect(record).not.toHaveBeenCalled()
  })

  it('records nothing when there was no worktree HEAD to read', async () => {
    const record = vi.fn()
    const remove = rememberGithubWorktreeRemoval(async () => ({ ok: true }), { readHead: async () => null, record })

    await remove({ repositoryRoot: '/repo', worktreePath: '/wt/a' })

    expect(record).not.toHaveBeenCalled()
  })

  it('still reports a successful removal when recording fails', async () => {
    const remove = rememberGithubWorktreeRemoval(async () => ({ ok: true }), {
      readHead: async () => SHA,
      record: () => { throw new Error('disk full') },
    })

    expect(await remove({ repositoryRoot: '/repo', worktreePath: '/wt/a' })).toEqual({ ok: true })
  })
})
