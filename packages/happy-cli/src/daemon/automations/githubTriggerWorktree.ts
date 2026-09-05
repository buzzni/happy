import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { releaseDanglingSubmoduleWorktreePointers } from './submoduleWorktreePointer'
import { describeUnsavedWorktreeChanges, hasUnsavedWorktreeChanges } from './worktreeDirtyState'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 60_000
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024

export interface GithubTriggerWorktreeCommand {
  executable: 'git' | 'gh'
  args: string[]
  cwd: string
  environmentVariables?: Record<string, string>
}

export interface GithubTriggerWorktreePlan {
  repositoryRoot: string
  worktreePath: string
  directory: string
}

export function isGithubTriggerWorktreeDirectoryInUse(input: {
  directory: string
  sessions: Iterable<[number, {
    directory?: string
    happySessionMetadataFromLocalWebhook?: { path?: string }
  }]>
  isPidAlive: (pid: number) => boolean
}): boolean {
  for (const [pid, session] of input.sessions) {
    const sessionDirectory = session.directory ?? session.happySessionMetadataFromLocalWebhook?.path
    if (sessionDirectory === input.directory && input.isPidAlive(pid)) return true
  }
  return false
}

type CommandResult = { ok: true; stdout: string } | { ok: false; error: string }

async function defaultRunCommand(command: GithubTriggerWorktreeCommand): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd: command.cwd,
      env: command.environmentVariables
        ? { ...process.env, ...command.environmentVariables }
        : process.env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      encoding: 'utf8',
    })
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    return { ok: false, error: failure.stderr?.trim() || failure.message || 'command failed' }
  }
}

function worktreeName(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 24)
}

function cleanSha(value: string): string | null {
  const sha = value.trim()
  return /^[a-f0-9]{40,64}$/i.test(sha) ? sha.toLowerCase() : null
}

async function commandOrError(
  runCommand: (command: GithubTriggerWorktreeCommand) => Promise<CommandResult>,
  command: GithubTriggerWorktreeCommand,
  label: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const result = await runCommand(command)
  return result.ok ? result : { ok: false, error: `${label}: ${result.error}` }
}

export async function removeGithubTriggerWorktree(input: {
  repositoryRoot: string
  worktreePath: string
  runCommand?: (command: GithubTriggerWorktreeCommand) => Promise<CommandResult>
  releaseSubmodulePointers?: (input: { repositoryRoot: string }) => Promise<{ released: string[] }>
  pathExists?: (path: string) => Promise<boolean>
}): Promise<
  | { ok: true }
  | { ok: false; dirty: boolean; error: string }
> {
  const runCommand = input.runCommand ?? defaultRunCommand
  const pathExists = input.pathExists ?? (async (path: string) => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  })
  if (!await pathExists(input.worktreePath)) return { ok: true }
  const status = await commandOrError(runCommand, {
    executable: 'git',
    args: ['status', '--porcelain', '--untracked-files=all'],
    cwd: input.worktreePath,
  }, 'GitHub automation worktree status failed')
  if (!status.ok) return { ok: false, dirty: false, error: status.error }
  // 한 줄이라도 있으면 보존하던 것이 worktree 45개(23GB)를 쌓았다. 사유가 작업물이
  // 아니라 에이전트 산출물(?? memory/)과 서브모듈 gitlink( M vendor/happy)였기 때문이다.
  // 무해하다고 아는 것만 무시하고, 하나라도 진짜 변경이 섞이면 그대로 지킨다.
  if (hasUnsavedWorktreeChanges(status.stdout)) {
    // 무엇이 막고 있는지 말한다 — 이 보류는 그 저장소의 리뷰 큐를 멈추므로,
    // 사람이 git status 를 다시 치게 만들면 그만큼 큐가 더 오래 멈춘다.
    const blocking = describeUnsavedWorktreeChanges(status.stdout).join(', ')
    return { ok: false, dirty: true, error: `GitHub automation worktree is dirty (${blocking})` }
  }
  const removed = await commandOrError(runCommand, {
    executable: 'git',
    // --force 없이는 서브모듈을 가진 worktree 를 git 이 거부한다
    // ("working trees containing submodules cannot be moved or removed").
    // 바로 위의 dirty 검사가 이미 "잃을 변경이 없다"를 보장하므로, 여기서의
    // --force 는 서브모듈 제약을 넘기 위한 것이지 작업물을 버리는 것이 아니다.
    args: ['worktree', 'remove', '--force', input.worktreePath],
    cwd: input.repositoryRoot,
  }, 'GitHub automation worktree removal failed')
  if (!removed.ok) return { ok: false, dirty: false, error: removed.error }
  // 방금 지운 worktree 를 서브모듈 core.worktree 가 가리키고 있으면 저장소의 모든
  // 체크아웃에서 git 이 죽는다. 청소의 일부다.
  await (input.releaseSubmodulePointers ?? releaseDanglingSubmoduleWorktreePointers)({
    repositoryRoot: input.repositoryRoot,
  })
  return { ok: true }
}

export async function prepareGithubTriggerWorktree(input: {
  runId: string
  directory: string
  managedRoot: string
  pullRequest?: { number: number; expectedHeadSha?: string | null }
  githubEnvironment?: Record<string, string>
  runCommand?: (command: GithubTriggerWorktreeCommand) => Promise<CommandResult>
  releaseSubmodulePointers?: (input: { repositoryRoot: string }) => Promise<{ released: string[] }>
  ensureDirectory?: (path: string) => Promise<void>
  pathExists?: (path: string) => Promise<boolean>
  resolveRealPath?: (path: string) => Promise<string>
  onPlanned: (plan: GithubTriggerWorktreePlan) => void
}): Promise<
  | ({ ok: true } & GithubTriggerWorktreePlan)
  | { ok: false; error: string; cleaned: boolean }
> {
  const runCommand = input.runCommand ?? defaultRunCommand
  const root = await commandOrError(runCommand, {
    executable: 'git', args: ['rev-parse', '--show-toplevel'], cwd: input.directory,
  }, 'GitHub automation repository lookup failed')
  if (!root.ok) return { ok: false, error: root.error, cleaned: true }

  const repositoryRoot = resolve(root.stdout.trim())
  const projectRelativePath = relative(repositoryRoot, resolve(input.directory))
  if (projectRelativePath === '..' || projectRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(projectRelativePath)) {
    return { ok: false, error: 'GitHub automation directory is outside the repository', cleaned: true }
  }

  let expectedHeadSha = input.pullRequest?.expectedHeadSha
    ? cleanSha(input.pullRequest.expectedHeadSha)
    : null
  if (input.pullRequest?.expectedHeadSha && !expectedHeadSha) {
    return { ok: false, error: 'GitHub trigger expected HEAD is invalid', cleaned: true }
  }
  if (input.pullRequest && !expectedHeadSha) {
    const queried = await commandOrError(runCommand, {
      executable: 'gh',
      args: ['pr', 'view', String(input.pullRequest.number), '--json', 'headRefOid', '--jq', '.headRefOid'],
      cwd: repositoryRoot,
      ...(input.githubEnvironment ? { environmentVariables: input.githubEnvironment } : {}),
    }, 'GitHub pull request HEAD lookup failed')
    if (!queried.ok) return { ok: false, error: queried.error, cleaned: true }
    expectedHeadSha = cleanSha(queried.stdout)
    if (!expectedHeadSha) {
      return { ok: false, error: 'GitHub pull request HEAD lookup returned invalid data', cleaned: true }
    }
  }

  try {
    await (input.ensureDirectory ?? (async (path: string) => {
      await mkdir(path, { recursive: true, mode: 0o700 })
      await chmod(path, 0o700)
    }))(input.managedRoot)
  } catch (error) {
    return {
      ok: false,
      error: `GitHub automation worktree root creation failed: ${error instanceof Error ? error.message : String(error)}`,
      cleaned: true,
    }
  }
  const worktreePath = join(resolve(input.managedRoot), worktreeName(input.runId))
  const directory = projectRelativePath.length > 0
    ? join(worktreePath, projectRelativePath)
    : worktreePath
  const plan = { repositoryRoot, worktreePath, directory }
  input.onPlanned(plan)

  // 앞선 실행이 남긴 core.worktree 가 이미 지워진 worktree 를 가리키면 이 저장소의
  // git 명령이 전부 죽는다 — worktree add 자체도 같은 오류로 실패하므로 먼저 푼다.
  await (input.releaseSubmodulePointers ?? releaseDanglingSubmoduleWorktreePointers)({
    repositoryRoot,
  })

  const added = await commandOrError(runCommand, {
    executable: 'git', args: ['worktree', 'add', '--detach', worktreePath, 'HEAD'], cwd: repositoryRoot,
  }, 'GitHub automation worktree creation failed')
  if (!added.ok) return { ok: false, error: added.error, cleaned: false }

  const failAfterCreation = async (error: string) => {
    const cleanup = await removeGithubTriggerWorktree({
      repositoryRoot,
      worktreePath,
      runCommand,
      ...(input.pathExists ? { pathExists: input.pathExists } : {}),
    })
    return { ok: false as const, error, cleaned: cleanup.ok }
  }

  if (input.pullRequest) {
    const checkedOut = await commandOrError(runCommand, {
      executable: 'gh',
      args: ['pr', 'checkout', String(input.pullRequest.number), '--detach'],
      cwd: worktreePath,
      ...(input.githubEnvironment ? { environmentVariables: input.githubEnvironment } : {}),
    }, 'GitHub pull request checkout failed')
    if (!checkedOut.ok) return failAfterCreation(checkedOut.error)

    const actual = await commandOrError(runCommand, {
      executable: 'git', args: ['rev-parse', 'HEAD'], cwd: worktreePath,
    }, 'GitHub worktree HEAD verification failed')
    if (!actual.ok) return failAfterCreation(actual.error)
    const actualHeadSha = cleanSha(actual.stdout)
    if (!actualHeadSha) return failAfterCreation('GitHub worktree HEAD verification returned invalid data')
    if (actualHeadSha !== expectedHeadSha) {
      return failAfterCreation(
        `GitHub worktree HEAD mismatch: expected ${expectedHeadSha}, got ${actualHeadSha}`,
      )
    }
  }

  const pathExists = input.pathExists ?? (async (path: string) => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  })
  if (!await pathExists(directory)) {
    return failAfterCreation('GitHub automation project directory is absent from the prepared worktree')
  }

  try {
    const resolveRealPath = input.resolveRealPath ?? realpath
    const actualWorktreePath = await resolveRealPath(worktreePath)
    const actualDirectory = await resolveRealPath(directory)
    const actualRelativePath = relative(actualWorktreePath, actualDirectory)
    if (actualRelativePath === '..'
        || actualRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        || isAbsolute(actualRelativePath)) {
      return failAfterCreation('GitHub automation project directory resolves outside the prepared worktree')
    }
  } catch (error) {
    return failAfterCreation(
      `GitHub automation project directory resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return { ok: true, ...plan }
}
