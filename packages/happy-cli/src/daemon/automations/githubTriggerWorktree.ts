import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

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
  if (status.stdout.trim().length > 0) {
    return { ok: false, dirty: true, error: 'GitHub automation worktree is dirty' }
  }
  const removed = await commandOrError(runCommand, {
    executable: 'git',
    args: ['worktree', 'remove', input.worktreePath],
    cwd: input.repositoryRoot,
  }, 'GitHub automation worktree removal failed')
  return removed.ok ? { ok: true } : { ok: false, dirty: false, error: removed.error }
}

export async function prepareGithubTriggerWorktree(input: {
  runId: string
  directory: string
  managedRoot: string
  pullRequest?: { number: number; expectedHeadSha?: string | null }
  githubEnvironment?: Record<string, string>
  runCommand?: (command: GithubTriggerWorktreeCommand) => Promise<CommandResult>
  ensureDirectory?: (path: string) => Promise<void>
  pathExists?: (path: string) => Promise<boolean>
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

  return { ok: true, ...plan }
}
