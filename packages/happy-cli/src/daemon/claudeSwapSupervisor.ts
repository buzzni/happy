import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { withUvToolBinOnPath, type AiCredentialRotationStatus } from './aiCredentialRuntime'

export type ClaudeSwapChild = {
  pid?: number
  stdout?: { on(event: 'data', listener: (data: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (data: Buffer) => void): unknown } | null
  kill(signal: NodeJS.Signals): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

type SupervisorDependencies = {
  readEnabled(): Promise<boolean>
  writeEnabled(enabled: boolean): Promise<void>
  spawn(command: string, args: string[]): ClaudeSwapChild
  schedule(callback: () => void, delay: number): unknown
  clearSchedule(handle: unknown): void
}

export class ClaudeSwapSupervisor {
  private enabled = false
  private child: ClaudeSwapChild | null = null
  private restartHandle: unknown = null
  private restartAttempts = 0
  private stdoutBuffer = ''
  private quarantinedAccounts = new Set<string>()
  private currentStatus: AiCredentialRotationStatus = {
    state: 'stopped',
    lastErrorKind: null,
  }

  constructor(private readonly deps: SupervisorDependencies) {}

  async restore(): Promise<void> {
    this.enabled = await this.deps.readEnabled()
    if (this.enabled) this.start()
  }

  async enable(): Promise<void> {
    const wasEnabled = this.enabled
    this.enabled = true
    try {
      await this.deps.writeEnabled(true)
    } catch (error) {
      this.enabled = wasEnabled
      throw error
    }
    this.start()
  }

  async stop(): Promise<void> {
    const wasEnabled = this.enabled
    this.enabled = false
    try {
      await this.deps.writeEnabled(false)
    } catch (error) {
      this.enabled = wasEnabled
      throw error
    }
    this.shutdown()
  }

  shutdown(): void {
    if (this.restartHandle !== null) {
      this.deps.clearSchedule(this.restartHandle)
      this.restartHandle = null
    }
    const running = this.child
    this.child = null
    if (running) running.kill('SIGTERM')
    this.restartAttempts = 0
    this.stdoutBuffer = ''
    this.currentStatus = { state: 'stopped', lastErrorKind: null }
  }

  status(): AiCredentialRotationStatus {
    return { ...this.currentStatus }
  }

  private start(): void {
    if (!this.enabled || this.child) return
    this.currentStatus = { ...this.currentStatus, state: 'starting', lastErrorKind: null }
    const child = this.deps.spawn('cswap', ['auto', '--strategy', 'consume-first', '--json'])
    this.child = child
    this.currentStatus = { ...this.currentStatus, ...this.healthyStatus() }

    // Drain both streams without logging their contents. Future claude-swap
    // versions may add account or credential fields to JSON events.
    this.stdoutBuffer = ''
    child.stdout?.on('data', (data) => this.consumeStdout(data))
    child.stderr?.on('data', () => undefined)
    const scheduleRestart = (lastErrorKind: string) => {
      if (this.child !== child) return
      this.child = null
      if (!this.enabled) return
      this.currentStatus = {
        ...this.currentStatus,
        state: 'blocked',
        lastErrorKind,
      }
      const delay = Math.min(1_000 * (2 ** this.restartAttempts), 60_000)
      this.restartAttempts += 1
      this.restartHandle = this.deps.schedule(() => {
        this.restartHandle = null
        this.start()
      }, delay)
    }
    child.on('error', () => scheduleRestart('PROCESS_START_FAILED'))
    child.on('exit', (code) => scheduleRestart(code === 0 ? 'PROCESS_STOPPED' : 'PROCESS_EXITED'))
  }

  private consumeStdout(data: Buffer): void {
    this.stdoutBuffer += data.toString('utf8')
    if (this.stdoutBuffer.length > 64 * 1024) {
      this.stdoutBuffer = ''
      return
    }
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as unknown
        if (!isObject(event) || event.schemaVersion !== 1) continue
        if (event.event === 'all-exhausted') {
          this.currentStatus = {
            ...this.currentStatus,
            state: 'blocked',
            lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED',
          }
        } else if (event.event === 'error') {
          this.currentStatus = {
            ...this.currentStatus,
            state: 'blocked',
            lastErrorKind: 'ROTATION_ERROR',
          }
        } else if (event.event === 'account-quarantined'
          && typeof event.number === 'string'
          && event.number.length > 0) {
          this.quarantinedAccounts.add(event.number)
          this.currentStatus = {
            ...this.currentStatus,
            state: 'needs-reauth',
            lastErrorKind: 'ACCOUNT_NEEDS_REAUTH',
          }
        } else if (event.event === 'account-unquarantined'
          && typeof event.number === 'string') {
          this.quarantinedAccounts.delete(event.number)
          if (this.currentStatus.state === 'needs-reauth') {
            this.currentStatus = { ...this.currentStatus, ...this.healthyStatus() }
          }
        } else if (event.event === 'poll' && isObject(event.active)) {
          this.restartAttempts = 0
        } else if (event.event === 'no-switch'
          && typeof event.reason === 'string'
          && HEALTHY_NO_SWITCH_REASONS.has(event.reason)) {
          this.currentStatus = { ...this.currentStatus, ...this.healthyStatus() }
        } else if (event.event === 'no-switch'
          && typeof event.reason === 'string'
          && BLOCKED_NO_SWITCH_REASONS.has(event.reason)) {
          this.currentStatus = {
            ...this.currentStatus,
            state: 'blocked',
            lastErrorKind: 'NO_VIABLE_ACCOUNT',
          }
        } else if (event.event === 'switch'
          && event.dryRun !== true
          && typeof event.ts === 'string'
          && Number.isFinite(Date.parse(event.ts))
          && isObject(event.to)
          && typeof event.to.email === 'string') {
          this.restartAttempts = 0
          this.currentStatus = {
            ...this.currentStatus,
            ...this.healthyStatus(),
            lastSwitchAt: event.ts,
            activeAccount: maskEmail(event.to.email),
          }
        }
      } catch {
        // Ignore non-JSON diagnostic lines without retaining or logging them.
      }
    }
  }

  private healthyStatus(): Pick<AiCredentialRotationStatus, 'state' | 'lastErrorKind'> {
    return this.quarantinedAccounts.size > 0
      ? { state: 'needs-reauth', lastErrorKind: 'ACCOUNT_NEEDS_REAUTH' }
      : { state: 'running', lastErrorKind: null }
  }
}

const HEALTHY_NO_SWITCH_REASONS = new Set([
  'active-api-key',
  'already-consuming-soonest',
  'below-threshold',
  'cooldown',
  'reset-unknown',
])

const BLOCKED_NO_SWITCH_REASONS = new Set([
  'no-candidates',
  'no-comparison',
  'no-qualifying-candidate',
  'no-viable-target',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

export function createClaudeSwapSupervisor(stateFile: string): ClaudeSwapSupervisor {
  return new ClaudeSwapSupervisor({
    readEnabled: async () => {
      try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as { enabled?: unknown }
        return parsed.enabled === true
      } catch {
        return false
      }
    },
    writeEnabled: async (enabled) => {
      await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
      const temp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 })
      await rename(temp, stateFile)
    },
    spawn: (command, args) => nodeSpawn(command, args, {
      env: withUvToolBinOnPath(process.env, homedir()),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }),
    schedule: (callback, delay) => setTimeout(callback, delay),
    clearSchedule: (handle) => clearTimeout(handle as NodeJS.Timeout),
  })
}
