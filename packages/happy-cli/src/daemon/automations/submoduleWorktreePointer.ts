import { execFile } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 30_000

export interface SubmoduleWorktreePointerCommand {
  args: string[]
  cwd: string
}

type CommandResult = { ok: true; stdout: string } | { ok: false; error: string }

async function defaultRunCommand(command: SubmoduleWorktreePointerCommand): Promise<CommandResult> {
  try {
    const result = await execFileAsync('git', command.args, {
      cwd: command.cwd,
      timeout: COMMAND_TIMEOUT_MS,
      encoding: 'utf8',
    })
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    const failure = error as { stderr?: string; message?: string }
    return { ok: false, error: failure.stderr?.trim() || failure.message || 'command failed' }
  }
}

async function defaultListModuleConfigs(commonGitDir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(directory, entry.name))
      else if (entry.name === 'config') found.push(join(directory, entry.name))
    }
  }
  await walk(join(commonGitDir, 'modules'))
  return found
}

/**
 * 삭제된 worktree 를 가리키는 서브모듈 `core.worktree` 를 해제한다.
 *
 * 2026-09-02 프로덕션 — 공유 `.git/modules/vendor/happy/config` 의 core.worktree 가
 * 이미 지워진 자동화 worktree 를 가리켜, 그 저장소의 모든 체크아웃에서
 * `git status`·`git checkout`·`git fetch` 가 "cannot chdir to ..." 로 죽었다.
 * core.worktree 는 값이 하나뿐인데 worktree 는 여럿이라 마지막에 잡은 쪽이 이기고,
 * 그 worktree 가 사라지면 저장소 전체가 같이 막힌다.
 *
 * 값을 "올바른" 경로로 되돌리려 하지 않는다 — 어느 worktree 가 주인인지는 여기서
 * 알 수 없다. 해제하면 git 은 서브모듈 내용을 못 볼 뿐 정상 동작한다(확인함).
 * 가리키는 경로가 살아 있으면 건드리지 않는다.
 */
export async function releaseDanglingSubmoduleWorktreePointers(input: {
  repositoryRoot: string
  runCommand?: (command: SubmoduleWorktreePointerCommand) => Promise<CommandResult>
  listModuleConfigs?: (commonGitDir: string) => Promise<string[]>
  pathExists?: (path: string) => Promise<boolean>
}): Promise<{ released: string[] }> {
  const runCommand = input.runCommand ?? defaultRunCommand
  const listModuleConfigs = input.listModuleConfigs ?? defaultListModuleConfigs
  const pathExists = input.pathExists ?? (async (path: string) => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  })

  const commonDir = await runCommand({
    args: ['rev-parse', '--git-common-dir'],
    cwd: input.repositoryRoot,
  })
  if (!commonDir.ok) return { released: [] }
  const commonGitDir = (() => {
    const value = commonDir.stdout.trim()
    return isAbsolute(value) ? value : resolve(input.repositoryRoot, value)
  })()

  const released: string[] = []
  for (const configPath of await listModuleConfigs(commonGitDir)) {
    const pointer = await runCommand({
      args: ['config', '-f', configPath, '--get', 'core.worktree'],
      cwd: input.repositoryRoot,
    })
    if (!pointer.ok) continue
    const value = pointer.stdout.trim()
    if (value.length === 0) continue
    // core.worktree 는 module 디렉토리 기준 상대 경로다. 저장소 루트 기준으로
    // 풀면 엉뚱한 곳을 검사하게 된다.
    const target = isAbsolute(value) ? value : resolve(dirname(configPath), value)
    if (await pathExists(target)) continue
    const cleared = await runCommand({
      args: ['config', '-f', configPath, '--unset', 'core.worktree'],
      cwd: input.repositoryRoot,
    })
    if (cleared.ok) released.push(configPath)
  }
  return { released }
}
