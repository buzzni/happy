import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import {
  isGithubTriggerWorktreeDirectoryInUse,
  prepareGithubTriggerWorktree,
  removeGithubTriggerWorktree,
  type GithubTriggerWorktreeCommand,
} from './githubTriggerWorktree'

const HEAD = 'a'.repeat(40)
const execFileAsync = promisify(execFile)

function commandRunner(outputs: string[]) {
  return vi.fn(async (_command: GithubTriggerWorktreeCommand) => ({
    ok: true as const,
    stdout: outputs.shift() ?? '',
  }))
}

describe('prepareGithubTriggerWorktree', () => {
  it('checks out the detected PR head in a unique worktree and preserves a monorepo project cwd', async () => {
    const runCommand = commandRunner(['/repo\n', '', '', `${HEAD}\n`])
    const onPlanned = vi.fn()

    const result = await prepareGithubTriggerWorktree({
      runId: 'run-1',
      directory: '/repo/apps/web',
      managedRoot: '/happy/automation-worktrees',
      pullRequest: { number: 12, expectedHeadSha: HEAD },
      githubEnvironment: { GH_TOKEN: 'secret', GH_REPO: 'acme/app' },
      runCommand,
      pathExists: vi.fn(async () => true),
      resolveRealPath: vi.fn(async (path) => path),
      ensureDirectory: vi.fn(async () => undefined),
      onPlanned,
    })

    expect(result).toEqual({
      ok: true,
      directory: expect.stringMatching(/^\/happy\/automation-worktrees\/[a-f0-9]{24}\/apps\/web$/),
      repositoryRoot: '/repo',
      worktreePath: expect.stringMatching(/^\/happy\/automation-worktrees\/[a-f0-9]{24}$/),
    })
    const worktreePath = result.ok ? result.worktreePath : ''
    expect(onPlanned).toHaveBeenCalledWith({
      repositoryRoot: '/repo',
      worktreePath,
      directory: `${worktreePath}/apps/web`,
    })
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      { executable: 'git', args: ['rev-parse', '--show-toplevel'], cwd: '/repo/apps/web' },
      { executable: 'git', args: ['worktree', 'add', '--detach', worktreePath, 'HEAD'], cwd: '/repo' },
      {
        executable: 'gh', args: ['pr', 'checkout', '12', '--detach'], cwd: worktreePath,
        environmentVariables: { GH_TOKEN: 'secret', GH_REPO: 'acme/app' },
      },
      { executable: 'git', args: ['rev-parse', 'HEAD'], cwd: worktreePath },
    ])
  })

  it('removes the prepared worktree and fails closed when checkout resolves a different head', async () => {
    const actualHead = 'b'.repeat(40)
    const runCommand = commandRunner(['/repo\n', '', '', `${actualHead}\n`, '', ''])

    const result = await prepareGithubTriggerWorktree({
      runId: 'run-2',
      directory: '/repo',
      managedRoot: '/happy/automation-worktrees',
      pullRequest: { number: 12, expectedHeadSha: HEAD },
      runCommand,
      pathExists: vi.fn(async () => true),
      resolveRealPath: vi.fn(async (path) => path),
      ensureDirectory: vi.fn(async () => undefined),
      onPlanned: vi.fn(),
    })

    expect(result).toEqual({
      ok: false,
      error: `GitHub worktree HEAD mismatch: expected ${HEAD}, got ${actualHead}`,
      cleaned: true,
    })
    expect(runCommand.mock.calls.at(-2)?.[0]).toMatchObject({
      executable: 'git', args: ['status', '--porcelain', '--untracked-files=all'],
    })
    expect(runCommand.mock.calls.at(-1)?.[0]).toMatchObject({
      executable: 'git', args: ['worktree', 'remove', expect.any(String)], cwd: '/repo',
    })
  })

  it('removes the worktree and fails closed when the monorepo project path is absent at the PR head', async () => {
    const runCommand = commandRunner(['/repo\n', '', '', `${HEAD}\n`, '', ''])
    const pathExists = vi.fn(async (path: string) => !path.endsWith('/apps/web'))

    const result = await prepareGithubTriggerWorktree({
      runId: 'run-3',
      directory: '/repo/apps/web',
      managedRoot: '/happy/automation-worktrees',
      pullRequest: { number: 12, expectedHeadSha: HEAD },
      runCommand,
      pathExists,
      resolveRealPath: vi.fn(async (path) => path),
      ensureDirectory: vi.fn(async () => undefined),
      onPlanned: vi.fn(),
    })

    expect(result).toEqual({
      ok: false,
      error: 'GitHub automation project directory is absent from the prepared worktree',
      cleaned: true,
    })
    expect(runCommand.mock.calls.at(-1)?.[0]).toMatchObject({
      executable: 'git', args: ['worktree', 'remove', expect.any(String)], cwd: '/repo',
    })
  })

  it('returns a typed failure before journaling or git mutation when the managed root cannot be created', async () => {
    const runCommand = commandRunner(['/repo\n'])
    const onPlanned = vi.fn()

    const result = await prepareGithubTriggerWorktree({
      runId: 'run-4',
      directory: '/repo',
      managedRoot: '/happy/automation-worktrees',
      runCommand,
      ensureDirectory: vi.fn(async () => { throw new Error('permission denied') }),
      onPlanned,
    })

    expect(result).toEqual({
      ok: false,
      error: 'GitHub automation worktree root creation failed: permission denied',
      cleaned: true,
    })
    expect(onPlanned).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('rejects a PR project path that resolves outside the managed worktree', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-worktree-symlink-'))
    const repositoryRoot = join(fixtureRoot, 'repo')
    const projectPath = join(repositoryRoot, 'apps', 'web')
    const outsidePath = join(fixtureRoot, 'outside')
    const managedRoot = join(fixtureRoot, 'managed')
    let plannedWorktreePath: string | undefined

    const git = async (args: string[], cwd = repositoryRoot) => {
      const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
      return result.stdout
    }

    try {
      await mkdir(projectPath, { recursive: true })
      await mkdir(outsidePath, { recursive: true })
      await git(['init'])
      await git(['config', 'user.name', 'Test'])
      await git(['config', 'user.email', 'test@example.com'])
      await writeFile(join(projectPath, 'app.ts'), 'export {}\n')
      await git(['add', '.'])
      await git(['commit', '-m', 'base'])
      const baseHead = (await git(['rev-parse', 'HEAD'])).trim()

      await rm(projectPath, { recursive: true })
      await symlink(outsidePath, projectPath, 'dir')
      await git(['add', '-A'])
      await git(['commit', '-m', 'replace project with external symlink'])
      const pullRequestHead = (await git(['rev-parse', 'HEAD'])).trim()
      await git(['checkout', '--detach', baseHead])

      const result = await prepareGithubTriggerWorktree({
        runId: 'symlink-escape',
        directory: projectPath,
        managedRoot,
        pullRequest: { number: 12, expectedHeadSha: pullRequestHead },
        runCommand: async (command) => {
          const executable = command.executable === 'gh' ? 'git' : command.executable
          const args = command.executable === 'gh'
            ? ['checkout', '--detach', pullRequestHead]
            : command.args
          try {
            const commandResult = await execFileAsync(executable, args, {
              cwd: command.cwd,
              encoding: 'utf8',
            })
            return { ok: true, stdout: commandResult.stdout }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
        onPlanned: (plan) => {
          plannedWorktreePath = plan.worktreePath
        },
      })

      expect(result).toEqual({
        ok: false,
        error: 'GitHub automation project directory resolves outside the prepared worktree',
        cleaned: true,
      })
    } finally {
      if (plannedWorktreePath) {
        await git(['worktree', 'remove', plannedWorktreePath]).catch(() => undefined)
      }
      await rm(fixtureRoot, { recursive: true })
    }
  })
})

describe('removeGithubTriggerWorktree', () => {
  it('treats an already absent worktree as cleaned without invoking git', async () => {
    const runCommand = commandRunner([])

    const result = await removeGithubTriggerWorktree({
      repositoryRoot: '/repo',
      worktreePath: '/happy/automation-worktrees/missing',
      runCommand,
      pathExists: vi.fn(async () => false),
    })

    expect(result).toEqual({ ok: true })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('preserves a dirty worktree without force removal', async () => {
    const runCommand = commandRunner([' M src/app.ts\n'])

    const result = await removeGithubTriggerWorktree({
      repositoryRoot: '/repo',
      worktreePath: '/happy/automation-worktrees/run-1',
      runCommand,
      pathExists: vi.fn(async () => true),
    })

    expect(result).toEqual({ ok: false, dirty: true, error: 'GitHub automation worktree is dirty' })
    expect(runCommand).toHaveBeenCalledTimes(1)
  })
})

describe('isGithubTriggerWorktreeDirectoryInUse', () => {
  it('keeps a pending pre-webhook spawn alive by its persisted launch directory', () => {
    const sessions = new Map([[101, {
      startedBy: 'daemon', pid: 101, directory: '/happy/automation-worktrees/run-1/apps/web',
    }]])

    expect(isGithubTriggerWorktreeDirectoryInUse({
      directory: '/happy/automation-worktrees/run-1/apps/web',
      sessions,
      isPidAlive: (pid) => pid === 101,
    })).toBe(true)
  })

  it('falls back to webhook metadata for sessions persisted before the launch directory field', () => {
    const sessions = new Map([[102, {
      startedBy: 'daemon', pid: 102,
      happySessionMetadataFromLocalWebhook: { path: '/happy/automation-worktrees/run-2' },
    }]])

    expect(isGithubTriggerWorktreeDirectoryInUse({
      directory: '/happy/automation-worktrees/run-2',
      sessions,
      isPidAlive: () => true,
    })).toBe(true)
  })
})
