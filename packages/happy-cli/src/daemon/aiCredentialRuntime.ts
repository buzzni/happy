import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_PAYLOAD_BYTES = 1024 * 1024
const CLAUDE_SWAP_VERSION = '0.25.0'

export type AiCredentialProvider = 'claude' | 'codex'

export type AiCredentialCommandResult = {
  stdout: string
  stderr: string
}

export type AiCredentialRotationStatus = {
  state: 'stopped' | 'starting' | 'running' | 'blocked'
  lastErrorKind: string | null
}

type CommandOptions = {
  input?: string
  maxOutputBytes?: number
}

type Supervisor = {
  enable(): Promise<void>
  stop(): Promise<void>
  status(): AiCredentialRotationStatus
}

export type AiCredentialRuntimeDependencies = {
  homeDir: string
  env: Record<string, string | undefined>
  execFile(command: string, args: string[], options?: CommandOptions): Promise<AiCredentialCommandResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  makeTempDir(): Promise<string>
  supervisor: Supervisor
}

export class AiCredentialRuntimeError extends Error {
  constructor(public readonly kind: string) {
    super(`AI credential operation failed (${kind})`)
  }
}

export function createAiCredentialRuntime(deps: AiCredentialRuntimeDependencies) {
  function provider(value: unknown): AiCredentialProvider {
    if (value !== 'claude' && value !== 'codex') {
      throw new AiCredentialRuntimeError('UNSUPPORTED_PROVIDER')
    }
    return value
  }

  function assertPayloadSize(payload: string): void {
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new AiCredentialRuntimeError('PAYLOAD_TOO_LARGE')
    }
  }

  function codexHome(): string {
    const configured = deps.env.CODEX_HOME
    return configured && configured.length > 0 ? configured : join(deps.homeDir, '.codex')
  }

  async function capture(input: { provider: AiCredentialProvider }) {
    const selected = provider(input?.provider)
    let payload: string
    if (selected === 'claude') {
      const result = await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })
      payload = result.stdout
    } else {
      try {
        payload = await deps.readFile(join(codexHome(), 'auth.json'))
      } catch {
        throw new AiCredentialRuntimeError('CODEX_FILE_STORE_REQUIRED')
      }
    }
    assertPayloadSize(payload)
    return { provider: selected, payload }
  }

  async function ensureClaudeSwap(): Promise<void> {
    await deps.execFile('uv', ['--version'])
    await deps.execFile('uv', ['python', 'find', '>=3.12'])
    let installed = false
    try {
      const version = await deps.execFile('cswap', ['--version'])
      installed = version.stdout.includes(CLAUDE_SWAP_VERSION)
    } catch {
      installed = false
    }
    if (!installed) {
      await deps.execFile('uv', [
        'tool', 'install', `claude-swap==${CLAUDE_SWAP_VERSION}`,
        '--python', '>=3.12', '--force',
      ])
    }
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.threshold', '95'])
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first'])
  }

  async function applyClaude(payload: string) {
    await ensureClaudeSwap()
    const tempDir = await deps.makeTempDir()
    const tempFile = join(tempDir, 'claude-swap.json')
    try {
      await deps.writeFile(tempFile, payload, { mode: 0o600 })
      await deps.chmod(tempFile, 0o600)
      await deps.execFile('cswap', ['import', tempFile, '--force'])
    } finally {
      await deps.rm(tempDir, { recursive: true, force: true })
    }
    await deps.execFile('cswap', ['list', '--json'])
    await deps.supervisor.enable()
    return {
      provider: 'claude' as const,
      configured: true,
      rotation: deps.supervisor.status(),
    }
  }

  async function applyCodex(payload: string) {
    const home = codexHome()
    const authPath = join(home, 'auth.json')
    const backupPath = join(home, 'auth.json.happy-backup')
    const tempPath = join(home, '.auth.json.happy-tmp')
    await deps.mkdir(home, { recursive: true, mode: 0o700 })
    let hadExisting = false
    try {
      await deps.rename(authPath, backupPath)
      await deps.chmod(backupPath, 0o600)
      hadExisting = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AiCredentialRuntimeError('CODEX_BACKUP_FAILED')
      }
    }
    try {
      await deps.writeFile(tempPath, payload, { mode: 0o600 })
      await deps.chmod(tempPath, 0o600)
      await deps.rename(tempPath, authPath)
      await deps.chmod(authPath, 0o600)
      await deps.execFile('codex', ['login', 'status'])
    } catch {
      await deps.rm(tempPath, { force: true })
      await deps.rm(authPath, { force: true })
      if (hadExisting) await deps.rename(backupPath, authPath)
      throw new AiCredentialRuntimeError('CODEX_APPLY_FAILED')
    }
    return { provider: 'codex' as const, configured: true, status: 'authenticated' as const }
  }

  async function apply(input: { provider: AiCredentialProvider; payload: string }) {
    const selected = provider(input?.provider)
    if (typeof input?.payload !== 'string') {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    assertPayloadSize(input.payload)
    return selected === 'claude' ? applyClaude(input.payload) : applyCodex(input.payload)
  }

  async function status(input: { provider: AiCredentialProvider }) {
    const selected = provider(input?.provider)
    if (selected === 'codex') {
      await deps.execFile('codex', ['login', 'status'])
      return { provider: selected, configured: true, status: 'authenticated' as const }
    }
    const result = await deps.execFile('cswap', ['list', '--json'], { maxOutputBytes: MAX_PAYLOAD_BYTES })
    let activeAccount: string | null = null
    try {
      const parsed = JSON.parse(result.stdout) as { activeAccount?: { email?: unknown } }
      if (typeof parsed.activeAccount?.email === 'string') {
        activeAccount = maskEmail(parsed.activeAccount.email)
      }
    } catch {
      throw new AiCredentialRuntimeError('CLAUDE_STATUS_INVALID')
    }
    return {
      provider: selected,
      configured: true,
      activeAccount,
      rotation: deps.supervisor.status(),
    }
  }

  async function rotation(input: { action: 'start' | 'stop' }) {
    if (input?.action === 'start') await deps.supervisor.enable()
    else if (input?.action === 'stop') await deps.supervisor.stop()
    else throw new AiCredentialRuntimeError('UNSUPPORTED_ROTATION_ACTION')
    return { provider: 'claude' as const, rotation: deps.supervisor.status() }
  }

  return { capture, apply, status, rotation }
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

export function createNodeAiCredentialRuntime(
  supervisor: Supervisor,
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
) {
  return createAiCredentialRuntime({
    homeDir,
    env,
    execFile: runCommand,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, content, options) => { await writeFile(path, content, options) },
    mkdir,
    rename,
    chmod,
    rm,
    makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-ai-credential-')),
    supervisor,
  })
}

function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<AiCredentialCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const fail = (kind: string) => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new AiCredentialRuntimeError(kind))
    }
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > (options.maxOutputBytes ?? MAX_PAYLOAD_BYTES)) {
        fail('COMMAND_OUTPUT_TOO_LARGE')
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.on('error', () => fail('COMMAND_NOT_AVAILABLE'))
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new AiCredentialRuntimeError('COMMAND_FAILED'))
        return
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input)
  })
}

export type AiCredentialRuntime = ReturnType<typeof createAiCredentialRuntime>
