/**
 * Size-bounded writer for one process-owned log path. Rotation keeps the base
 * path stable because daemon.state.json and `happy logs` both point to it.
 */

import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'

export interface LogRotationPolicy {
  maxFileBytes: number
  maxArchives: number
}

export const DEFAULT_LOG_ROTATION_POLICY: LogRotationPolicy = {
  maxFileBytes: 25 * 1024 * 1024,
  maxArchives: 3,
}

function readInteger(value: string | undefined, fallback: number, allowZero: boolean): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  const minimum = allowZero ? 0 : 1
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback
}

export function readLogRotationPolicy(env: NodeJS.ProcessEnv): LogRotationPolicy {
  return {
    maxFileBytes: readInteger(
      env.HAPPY_LOG_MAX_FILE_BYTES,
      DEFAULT_LOG_ROTATION_POLICY.maxFileBytes,
      false,
    ),
    maxArchives: readInteger(
      env.HAPPY_LOG_MAX_ARCHIVES,
      DEFAULT_LOG_ROTATION_POLICY.maxArchives,
      true,
    ),
  }
}

export class RotatingLogWriter {
  private currentBytes: number | null = null

  constructor(
    private readonly logFilePath: string,
    private readonly policy: LogRotationPolicy,
  ) {}

  append(line: string): void {
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (this.currentBytes === null) {
      this.currentBytes = existsSync(this.logFilePath) ? statSync(this.logFilePath).size : 0
    }
    if (this.currentBytes > 0 && this.currentBytes + lineBytes > this.policy.maxFileBytes) {
      try {
        this.rotate()
      } catch {
        appendFileSync(this.logFilePath, line)
        this.currentBytes += lineBytes
        return
      }
    }
    appendFileSync(this.logFilePath, line)
    this.currentBytes += lineBytes
  }

  private rotate(): void {
    if (this.policy.maxArchives === 0) {
      rmSync(this.logFilePath, { force: true })
      this.currentBytes = 0
      return
    }

    rmSync(`${this.logFilePath}.${this.policy.maxArchives}`, { force: true })
    for (let index = this.policy.maxArchives; index > 1; index -= 1) {
      const previous = `${this.logFilePath}.${index - 1}`
      if (existsSync(previous)) renameSync(previous, `${this.logFilePath}.${index}`)
    }
    if (existsSync(this.logFilePath)) renameSync(this.logFilePath, `${this.logFilePath}.1`)
    this.currentBytes = 0
  }
}
