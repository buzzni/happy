import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AiCredentialRotationStatus } from './aiCredentialRuntime'

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
    this.enabled = true
    await this.deps.writeEnabled(true)
    this.start()
  }

  async stop(): Promise<void> {
    this.enabled = false
    await this.deps.writeEnabled(false)
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
    this.currentStatus = { state: 'stopped', lastErrorKind: null }
  }

  status(): AiCredentialRotationStatus {
    return { ...this.currentStatus }
  }

  private start(): void {
    if (!this.enabled || this.child) return
    this.currentStatus = { state: 'starting', lastErrorKind: null }
    const child = this.deps.spawn('cswap', ['auto', '--strategy', 'consume-first', '--json'])
    this.child = child
    this.currentStatus = { state: 'running', lastErrorKind: null }

    // Drain both streams without logging their contents. Future claude-swap
    // versions may add account or credential fields to JSON events.
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', () => undefined)
    const scheduleRestart = (lastErrorKind: string) => {
      if (this.child !== child) return
      this.child = null
      if (!this.enabled) return
      this.currentStatus = {
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
      const temp = `${stateFile}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 })
      await rename(temp, stateFile)
    },
    spawn: (command, args) => nodeSpawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }),
    schedule: (callback, delay) => setTimeout(callback, delay),
    clearSchedule: (handle) => clearTimeout(handle as NodeJS.Timeout),
  })
}
