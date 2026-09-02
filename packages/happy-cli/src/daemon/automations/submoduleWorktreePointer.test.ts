import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

import { releaseDanglingSubmoduleWorktreePointers } from './submoduleWorktreePointer'

type Command = { args: string[]; cwd: string }

function gitStub(options: {
  commonGitDir?: string | null
  pointers: Record<string, string | null>
}) {
  const unset: string[] = []
  const runCommand = vi.fn(async (command: Command) => {
    const [first, second] = command.args
    if (first === 'rev-parse' && second === '--git-common-dir') {
      return options.commonGitDir === null
        ? { ok: false as const, error: 'not a git repository' }
        : { ok: true as const, stdout: `${options.commonGitDir ?? '/repo/.git'}\n` }
    }
    if (first === 'config') {
      const file = command.args[command.args.indexOf('-f') + 1]!
      if (command.args.includes('--unset')) {
        unset.push(file)
        return { ok: true as const, stdout: '' }
      }
      const value = options.pointers[file]
      return value
        ? { ok: true as const, stdout: `${value}\n` }
        : { ok: false as const, error: 'not found' }
    }
    throw new Error(`unexpected command: ${command.args.join(' ')}`)
  })
  return { runCommand, unset }
}

describe('releaseDanglingSubmoduleWorktreePointers', () => {
  const config = '/repo/.git/modules/vendor/happy/config'

  // 2026-09-02 프로덕션 — 공유 .git/modules/vendor/happy/config 의 core.worktree 가
  // 삭제된 자동화 worktree 를 가리켜, 저장소의 모든 체크아웃에서 git status·checkout·
  // fetch 가 "cannot chdir to ..." 로 죽었다. 값이 하나뿐인데 worktree 는 여럿이라
  // 마지막에 잡은 쪽이 이긴다.
  it('releases a pointer whose worktree no longer exists', async () => {
    const { runCommand, unset } = gitStub({
      pointers: { [config]: '../../../../../../gone/vendor/happy' },
    })
    const result = await releaseDanglingSubmoduleWorktreePointers({
      repositoryRoot: '/repo',
      runCommand,
      listModuleConfigs: async () => [config],
      pathExists: async () => false,
    })
    expect(result.released).toEqual([config])
    expect(unset).toEqual([config])
  })

  it('keeps a pointer whose worktree is still present', async () => {
    const { runCommand, unset } = gitStub({
      pointers: { [config]: '../../../../vendor/happy' },
    })
    const result = await releaseDanglingSubmoduleWorktreePointers({
      repositoryRoot: '/repo',
      runCommand,
      listModuleConfigs: async () => [config],
      pathExists: async () => true,
    })
    expect(result.released).toEqual([])
    expect(unset).toEqual([])
  })

  it('resolves the pointer against the module directory, not the repository root', async () => {
    const seen: string[] = []
    const { runCommand } = gitStub({
      pointers: { [config]: '../../../../vendor/happy' },
    })
    await releaseDanglingSubmoduleWorktreePointers({
      repositoryRoot: '/repo',
      runCommand,
      listModuleConfigs: async () => [config],
      pathExists: async (path) => { seen.push(path); return true },
    })
    expect(seen).toEqual(['/repo/vendor/happy'])
  })

  it('leaves a module config that names no worktree', async () => {
    const { runCommand, unset } = gitStub({ pointers: { [config]: null } })
    const result = await releaseDanglingSubmoduleWorktreePointers({
      repositoryRoot: '/repo',
      runCommand,
      listModuleConfigs: async () => [config],
      pathExists: async () => false,
    })
    expect(result.released).toEqual([])
    expect(unset).toEqual([])
  })

  // 이건 진단이자 청소다. 실패해도 worktree 준비·정리를 막아서는 안 된다.
  it('reports nothing instead of throwing when the common git directory is unreadable', async () => {
    const { runCommand } = gitStub({ commonGitDir: null, pointers: {} })
    await expect(releaseDanglingSubmoduleWorktreePointers({
      repositoryRoot: '/repo',
      runCommand,
      listModuleConfigs: async () => { throw new Error('must not be reached') },
      pathExists: async () => false,
    })).resolves.toEqual({ released: [] })
  })
})

// 목으로는 "해제하면 git 이 다시 도는가" 를 확인할 수 없다. 이전에 git 2.25 가
// 모르는 옵션을 usage 만 출력하고 종료 코드 0 으로 통과시켜 "성공했는데 아무 일도
// 일어나지 않은" 조용한 실패를 만든 적이 있어, 이 판정은 실제 git 으로 한다.
describe('releaseDanglingSubmoduleWorktreePointers against real git', () => {
  it('restores a repository whose submodule pointer names a deleted worktree', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-submodule-pointer-'))
    const dependency = join(fixtureRoot, 'dep')
    const repository = join(fixtureRoot, 'repo')
    const git = async (args: string[], cwd: string) => {
      const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
      return result.stdout
    }

    try {
      for (const [path, file] of [[dependency, 'dep.txt'], [repository, 'main.txt']] as const) {
        await execFileAsync('mkdir', ['-p', path])
        await git(['init'], path)
        await git(['config', 'user.name', 'Test'], path)
        await git(['config', 'user.email', 'test@example.com'], path)
        await writeFile(join(path, file), 'x\n')
        await git(['add', '.'], path)
        await git(['commit', '-m', 'base'], path)
      }
      await git(
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dep'],
        repository,
      )
      await git(['commit', '-m', 'add submodule'], repository)

      const moduleConfig = join(repository, '.git', 'modules', 'vendor', 'dep', 'config')
      await git(
        ['config', '-f', moduleConfig, 'core.worktree', '../../../../../deleted-worktree/vendor/dep'],
        repository,
      )

      // 프로덕션 증상: 저장소의 평범한 git 명령이 전부 죽는다.
      await expect(git(['status', '--porcelain'], repository)).rejects.toThrow(/cannot chdir/)

      const result = await releaseDanglingSubmoduleWorktreePointers({ repositoryRoot: repository })

      expect(result.released).toEqual([moduleConfig])
      await expect(git(['status', '--porcelain'], repository)).resolves.toBe('')
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })
})
