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
      executable: 'git', args: ['worktree', 'remove', '--force', expect.any(String)], cwd: '/repo',
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
      executable: 'git', args: ['worktree', 'remove', '--force', expect.any(String)], cwd: '/repo',
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

      expect(result).toMatchObject({ ok: false, cleaned: true })
    } finally {
      if (plannedWorktreePath) {
        await git(['worktree', 'remove', plannedWorktreePath]).catch(() => undefined)
      }
      await rm(fixtureRoot, { recursive: true })
    }
  })
})

  // 2026-09-02 프로덕션 — 공유 .git/modules/vendor/happy/config 의 core.worktree 가
  // 삭제된 자동화 worktree 를 가리켜 저장소의 모든 체크아웃에서 git 이 죽었다.
  // worktree 를 만들기 전에 풀어야 한다 — 막힌 저장소에서는 worktree add 자체가
  // 같은 오류로 실패한다.
  it('releases dangling submodule worktree pointers before creating the worktree', async () => {
    const order: string[] = []
    const runCommand = vi.fn(async (command: { executable: string; args: string[] }) => {
      order.push(`${command.executable} ${command.args.slice(0, 2).join(' ')}`)
      return { ok: true as const, stdout: command.args[0] === 'rev-parse' ? '/repo\n' : '' }
    })
    const releaseSubmodulePointers = vi.fn(async () => {
      order.push('release')
      return { released: ['/repo/.git/modules/vendor/happy/config'] }
    })

    await prepareGithubTriggerWorktree({
      runId: 'run-1',
      directory: '/repo',
      managedRoot: '/happy/automation-worktrees',
      runCommand,
      releaseSubmodulePointers,
      pathExists: vi.fn(async () => true),
      resolveRealPath: vi.fn(async (path: string) => path),
      ensureDirectory: vi.fn(async () => undefined),
      onPlanned: vi.fn(),
    })

    expect(releaseSubmodulePointers).toHaveBeenCalledWith({ repositoryRoot: '/repo' })
    expect(order.indexOf('release')).toBeLessThan(order.indexOf('git worktree add'))
  })

describe('removeGithubTriggerWorktree', () => {
  it('releases dangling submodule worktree pointers after removing the worktree', async () => {
    const runCommand = vi.fn(async () => ({ ok: true as const, stdout: '' }))
    const releaseSubmodulePointers = vi.fn(async () => ({ released: [] }))

    const result = await removeGithubTriggerWorktree({
      repositoryRoot: '/repo',
      worktreePath: '/happy/automation-worktrees/abc',
      runCommand,
      releaseSubmodulePointers,
      pathExists: vi.fn(async () => true),
    })

    expect(result).toEqual({ ok: true })
    expect(releaseSubmodulePointers).toHaveBeenCalledWith({ repositoryRoot: '/repo' })
  })

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

  // 2026-09-04 프로덕션 — 정리가 `git status` 한 줄만 있어도 보존해 worktree 45개
  // (23GB)가 쌓였다. 사유는 작업물이 아니라 에이전트 산출물과 서브모듈 gitlink 였다.
  // 순수 함수만 덮으면 배선이 빠져도 통과하므로 정리 경로에서 고정한다.
  it('removes a worktree whose only changes are agent scratch and the submodule gitlink', async () => {
    const runCommand = commandRunner(['?? memory/\n M vendor/happy\n', ''])

    const result = await removeGithubTriggerWorktree({
      repositoryRoot: '/repo',
      worktreePath: '/happy/automation-worktrees/run-1',
      runCommand,
      releaseSubmodulePointers: async () => ({ released: [] }),
      pathExists: vi.fn(async () => true),
    })

    expect(result).toEqual({ ok: true })
    expect(runCommand.mock.calls.map(([c]) => c.args.slice(0, 2))).toEqual([
      ['status', '--porcelain'],
      ['worktree', 'remove'],
    ])
  })

  it('still preserves a worktree when a real change is mixed with scratch output', async () => {
    const runCommand = commandRunner(['?? memory/\n M src/app.ts\n'])

    const result = await removeGithubTriggerWorktree({
      repositoryRoot: '/repo',
      worktreePath: '/happy/automation-worktrees/run-1',
      runCommand,
      pathExists: vi.fn(async () => true),
    })

    expect(result).toMatchObject({ ok: false, dirty: true })
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

  // 2026-08-30 프로덕션 — 리뷰가 끝난 worktree 11개가 지워지지 않고 2.3GB 를 물고
  // 앉아 있었다. 매분 재시도해 누적 1,192회 실패했다.
  //   fatal: working trees containing submodules cannot be moved or removed
  // 이 저장소는 vendor/happy 서브모듈을 갖고 있어 평범한 remove 가 항상 거부된다.
  // 바로 앞의 dirty 검사가 이미 "잃을 것이 없다"를 보장하므로 --force 가 안전하다.
  it('forces removal so a worktree containing submodules can be cleaned', async () => {
    const runCommand = commandRunner(['', ''])

    const result = await removeGithubTriggerWorktree({
      repositoryRoot: '/repo',
      worktreePath: '/happy/automation-worktrees/run-1',
      runCommand,
      pathExists: vi.fn(async () => true),
    })

    expect(result).toEqual({ ok: true })
    const removeCall = runCommand.mock.calls
      .map(([command]) => command)
      .find((command) => command.args[0] === 'worktree')
    expect(removeCall?.args).toEqual(['worktree', 'remove', '--force', '/happy/automation-worktrees/run-1'])
  })

  it('still refuses to force a dirty worktree', async () => {
    // --force 는 서브모듈을 넘기 위한 것이지, 작업 중인 변경을 버리기 위한 것이
    // 아니다. dirty 검사가 먼저 막아야 한다.
    const runCommand = commandRunner([' M src/app.ts\n'])

    const result = await removeGithubTriggerWorktree({
      repositoryRoot: '/repo',
      worktreePath: '/happy/automation-worktrees/run-1',
      runCommand,
      pathExists: vi.fn(async () => true),
    })

    expect(result).toMatchObject({ ok: false, dirty: true })
    expect(runCommand.mock.calls.every(([c]) => c.args[0] !== 'worktree')).toBe(true)
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
