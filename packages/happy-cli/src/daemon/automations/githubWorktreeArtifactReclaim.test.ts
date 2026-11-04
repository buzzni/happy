import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGithubArtifactReclaimer, isUninspectableProcess, parseLsofInventory } from './githubWorktreeArtifactReclaim'
import { removeGithubTriggerWorktree } from './githubTriggerWorktree'

const exec = promisify(execFile)
const DAY = 86_400_000
let root: string
let repo: string
let managedRoot: string
let worktreePath: string
let target: string
const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args])

async function ageTree(path: string) {
  const old = new Date(Date.now() - 3 * DAY)
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) await ageTree(child)
    else await utimes(child, old, old)
  }
  await utimes(path, old, old)
}

async function ageWorktree() {
  await ageTree(worktreePath)
  const admin = (await git(worktreePath, 'rev-parse', '--absolute-git-dir')).stdout.trim()
  await ageTree(admin)
}

function reclaimer(options: Partial<Parameters<typeof createGithubArtifactReclaimer>[0]> = {}) {
  return createGithubArtifactReclaimer({
    managedRoot, isDirectoryInUse: () => false, readLivePaths: async () => [repo], ...options,
  })
}

beforeEach(async () => {
  // macOS exposes its temporary directory through /var -> /private/var.
  // Fixtures use canonical owned paths, just as the production safety gate requires.
  root = await realpath(await mkdtemp(join(tmpdir(), 'github-artifact-reclaim-')))
  repo = join(root, 'repo')
  managedRoot = join(root, 'automation-worktrees')
  worktreePath = join(managedRoot, 'a'.repeat(24))
  target = join(worktreePath, 'node_modules')
  await mkdir(repo)
  await git(repo, 'init')
  await git(repo, 'config', 'user.email', 'fixture@example.test')
  await git(repo, 'config', 'user.name', 'Fixture')
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.next/\ncoverage/\n')
  await writeFile(join(repo, 'source.ts'), 'export const original = 1\n')
  await git(repo, 'add', '.')
  await git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
  await mkdir(managedRoot)
  await git(repo, 'worktree', 'add', '--detach', worktreePath, 'HEAD')
  await writeFile(join(worktreePath, 'source.ts'), 'export const original = 2\n')
  await writeFile(join(worktreePath, 'repro.test.ts'), 'valuable reproduction\n')
  await mkdir(target)
  await writeFile(join(target, 'downloaded.js'), 'regenerable dependency\n')
  await ageWorktree()
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('GitHub automation generated artifact reclamation', () => {
  it('reclaims old ignored dependencies while retaining dirty and untracked source and Git registration', async () => {
    const reclaim = reclaimer()
    let result: Awaited<ReturnType<typeof reclaim>> | undefined
    const removal = await removeGithubTriggerWorktree({
      repositoryRoot: repo, worktreePath,
      reclaimArtifacts: async () => { result = await reclaim({ repositoryRoot: repo, worktreePath }) },
    })
    expect(removal).toMatchObject({ ok: false, dirty: true })
    expect(result?.errors).toEqual([])
    expect(result).toBeDefined()
    if (!result) throw new Error('reclaimer was not invoked')
    expect(result.status).toBe('reclaimed')
    expect(result.deletedPaths).toEqual([target])
    expect(result.removedDirectoryBytes).toBeGreaterThan(0)
    expect(await readFile(join(worktreePath, 'source.ts'), 'utf8')).toContain('original = 2')
    expect(await readFile(join(worktreePath, 'repro.test.ts'), 'utf8')).toContain('valuable')
    expect((await git(repo, 'worktree', 'list', '--porcelain')).stdout).toContain(worktreePath)
    expect((await git(worktreePath, 'status', '--porcelain')).stdout).not.toContain('artifact-reclaim')
  })

  it('protects a live daemon session even when its provider uses a separate scratchpad', async () => {
    const result = await reclaimer({ isDirectoryInUse: () => true })({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips['live-session']).toBeGreaterThan(0)
  })

  it('protects external processes with open paths inside the worktree', async () => {
    const result = await reclaimer({ readLivePaths: async () => [join(target, 'downloaded.js')] })({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips['live-process']).toBeGreaterThan(0)
  })

  it('does not accept an unreadable OS path as a valid inventory entry', async () => {
    const result = await reclaimer({ readLivePaths: async () => ['/proc/123/fd (stat: Permission denied)'] })({ repositoryRoot: repo, worktreePath })
    expect(result.status).toBe('failed')
    expect(result.deletedPaths).toEqual([])
  })

  it.each(['failed', 'empty'])('refuses deletion when the process inventory is %s', async (kind) => {
    const readLivePaths = async (): Promise<string[]> => {
      if (kind === 'failed') throw new Error('inventory failed')
      return []
    }
    const result = await reclaimer({ readLivePaths })({ repositoryRoot: repo, worktreePath })
    expect(result.status).toBe('failed')
    expect(result.deletedPaths).toEqual([])
    expect(await readFile(join(target, 'downloaded.js'), 'utf8')).toContain('dependency')
  })

  it('protects force-added tracked descendants inside an ignored directory', async () => {
    await git(worktreePath, 'add', '-f', 'node_modules/downloaded.js')
    await ageWorktree()
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
  })

  it('protects nested repositories even when the parent is ignored', async () => {
    await git(target, 'init', 'nested')
    await ageWorktree()
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips['nested-repository']).toBeGreaterThan(0)
  })

  it('protects new content inside an otherwise old dependency directory', async () => {
    await utimes(join(target, 'downloaded.js'), new Date(), new Date())
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips['recently-active']).toBeGreaterThan(0)
  })

  it('reclaims multiple independent artifact directories in the same pass', async () => {
    const next = join(worktreePath, '.next')
    await mkdir(next)
    await writeFile(join(next, 'cache'), 'regenerable build')
    await ageWorktree()
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths.sort()).toEqual([target, next].sort())
  })

  it('protects locked worktrees', async () => {
    await git(repo, 'worktree', 'lock', worktreePath)
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips.locked).toBeGreaterThan(0)
  })

  it('does not follow a dependency symlink outside the worktree', async () => {
    await rm(target, { recursive: true })
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'valuable'), 'retain')
    await symlink(outside, target)
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(await readFile(join(outside, 'valuable'), 'utf8')).toBe('retain')
  })

  it('does not accept a symlink alias as its managed root', async () => {
    const alias = join(root, 'managed-alias')
    await symlink(managedRoot, alias)
    const result = await reclaimer({ managedRoot: alias })({
      repositoryRoot: repo, worktreePath: join(alias, 'a'.repeat(24)),
    })
    expect(result.status).toBe('failed')
    expect(result.deletedPaths).toEqual([])
    expect(await readFile(join(target, 'downloaded.js'), 'utf8')).toContain('dependency')
  })

  it('does not reclaim an unregistered lookalike under the managed namespace', async () => {
    await git(repo, 'worktree', 'remove', '--force', worktreePath)
    await mkdir(worktreePath)
    await git(worktreePath, 'init')
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.status).toBe('failed')
    expect(result.deletedPaths).toEqual([])
  })

  it('rechecks a resumed session after directory measurement, before deleting', async () => {
    let active = false
    const result = await reclaimer({
      isDirectoryInUse: () => active,
      directoryBytes: async () => { active = true; return 1024 },
    })({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips['live-session']).toBeGreaterThan(0)
  })

  it('protects new repository activity that appears during measurement', async () => {
    const result = await reclaimer({ directoryBytes: async () => {
      await writeFile(join(worktreePath, 'new-user-work.ts'), 'do not interrupt')
      return 1024
    } })({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips['recently-active']).toBeGreaterThan(0)
  })

  it('preserves artifacts when an existing receipt has unknown contents', async () => {
    const receiptRoot = join(managedRoot, '.artifact-reclaim')
    await mkdir(receiptRoot)
    const receipt = join(receiptRoot, `${'a'.repeat(24)}.json`)
    await writeFile(receipt, '{not a receipt}')
    const result = await reclaimer()({ repositoryRoot: repo, worktreePath })
    expect(result.status).toBe('failed')
    expect(result.deletedPaths).toEqual([])
    expect(await readFile(receipt, 'utf8')).toBe('{not a receipt}')
  })

  it('persists its recheck interval across daemon restarts without dirtying the worktree', async () => {
    await reclaimer()({ repositoryRoot: repo, worktreePath })
    const readLivePaths = vi.fn(async () => [repo])
    const result = await reclaimer({ readLivePaths })({ repositoryRoot: repo, worktreePath })
    expect(result.status).toBe('deferred')
    expect(readLivePaths).not.toHaveBeenCalled()
  })

  // `lsof -nP -a -u <uid> -Fpn` on a Linux PC running Node 20+ (libuv io_uring), a container and an SSH login.
  const linuxInventory = (...extra: string[]) => [
    'p4100', 'fcwd', 'n/home/user', 'f12', 'nanon_inode:[io_uring] (stat: No such file or directory)', 'f13', 'npipe',
    'f14', 'ntype=STREAM', 'p4200', 'fmem', 'n/usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.30 (stat: No such file or directory)',
    'p4300', 'fcwd', 'n/proc/4300/cwd (readlink: Permission denied)', 'frtd', 'n/proc/4300/root (readlink: Permission denied)',
    'ftxt', 'n/proc/4300/exe (readlink: Permission denied)', 'fNOFD', 'n/proc/4300/fd (opendir: Permission denied)',
    ...extra, '',
  ].join('\n')

  it('reclaims when the inventory has io_uring handles, unresolvable outside paths and uninspectable processes', async () => {
    const { paths, deniedPids } = parseLsofInventory(linuxInventory())
    expect(paths).toEqual(['/home/user', '/usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.30'])
    expect(deniedPids).toEqual(['4300'])
    const result = await reclaimer({ readLivePaths: async () => paths })({ repositoryRoot: repo, worktreePath })
    expect(result.errors).toEqual([])
    expect(result.deletedPaths).toEqual([target])
  })

  it('protects a worktree file named by a handle whose stat failed', async () => {
    const { paths } = parseLsofInventory(linuxInventory('p4400', 'fmem', `n${join(target, 'addon.node')} (stat: No such file or directory)`))
    const result = await reclaimer({ readLivePaths: async () => paths })({ repositoryRoot: repo, worktreePath })
    expect(result.deletedPaths).toEqual([])
    expect(result.skips['live-process']).toBeGreaterThan(0)
  })

  it.each([
    ['an unknown name', ['p4500', 'fcwd', 'nunknown']],
    ['a cwd that could not be read for another reason', ['p4500', 'fcwd', 'n/proc/4500/cwd (readlink: Input/output error)']],
    ['a denied link of a different process', ['p4500', 'fcwd', 'n/proc/4501/cwd (readlink: Permission denied)']],
  ])('treats an inventory with %s as incomplete', (_, extra) => {
    expect(() => parseLsofInventory(linuxInventory(...extra))).toThrow('incomplete process inventory')
  })

  it('treats an inventory without any process record as incomplete', () => {
    expect(() => parseLsofInventory('')).toThrow('incomplete process inventory')
  })

  it.skipIf(process.platform !== 'linux')('confirms a denied process only when the kernel hid its /proc entries', async () => {
    // PR_SET_DUMPABLE(0) is what setuid programs and sshd sessions end up with.
    const child = spawn('python3', ['-c', 'import ctypes,time; ctypes.CDLL(None).prctl(4, 0); print(1, flush=True); time.sleep(30)'],
      { stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      await new Promise((done, fail) => { child.stdout.once('data', done); child.once('error', fail) })
      expect(await isUninspectableProcess(String(child.pid), process.getuid!())).toBe(true)
      // Our own, readable process: a denial for it would have come from elsewhere, so it is not confirmed.
      expect(await isUninspectableProcess(String(process.pid), process.getuid!())).toBe(false)
      expect(await isUninspectableProcess('999999999', process.getuid!())).toBe(true)
    } finally { child.kill() }
  })

  it('shares simultaneous cleanup requests for the same worktree', async () => {
    const directoryBytes = vi.fn(async () => 1024)
    const reclaim = reclaimer({ directoryBytes })
    const input = { repositoryRoot: repo, worktreePath }
    const [first, second] = await Promise.all([reclaim(input), reclaim(input)])
    expect(first).toEqual(second)
    expect(directoryBytes).toHaveBeenCalledTimes(1)
  })
})
