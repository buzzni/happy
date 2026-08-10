import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type ServerAutomationReportOutcome = 'WOKE' | 'SILENT' | 'SKIPPED_GATE' | 'ERROR'

export interface ServerAutomationScheduleState {
  automationId: string
  generation: number
  nextRunAt: number
  lastSessionId: string | null
}

export interface PendingAutomationReport {
  runId: string
  claimToken: string
  reportId: string
  status: 'COMPLETED' | 'FAILED'
  outcome: ServerAutomationReportOutcome
  sessionId: string | null
  detailCiphertext: string | null
}

export interface ServerAutomationRuntimeState {
  schedules: ServerAutomationScheduleState[]
  pendingReports: PendingAutomationReport[]
}

export interface ServerAutomationRuntimeStore {
  read(): ServerAutomationRuntimeState
  write(state: ServerAutomationRuntimeState): void
}

function invalid(): never {
  throw new Error('automation-runtime-invalid')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) invalid()
  return value
}

function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid()
  return value as number
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}

function parse(raw: string): ServerAutomationRuntimeState {
  try {
    const disk = record(JSON.parse(raw))
    if (disk.version !== 1 || !Array.isArray(disk.schedules) || !Array.isArray(disk.pendingReports)) invalid()
    const schedules = disk.schedules.map((value) => {
      const row = record(value)
      return {
        automationId: text(row.automationId, 200),
        generation: integer(row.generation, 1),
        nextRunAt: integer(row.nextRunAt),
        lastSessionId: nullableText(row.lastSessionId),
      }
    })
    const outcomes = new Set<ServerAutomationReportOutcome>(['WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR'])
    const pendingReports = disk.pendingReports.map((value) => {
      const row = record(value)
      if ((row.status !== 'COMPLETED' && row.status !== 'FAILED')
        || !outcomes.has(row.outcome as ServerAutomationReportOutcome)) invalid()
      return {
        runId: text(row.runId, 200),
        claimToken: text(row.claimToken),
        reportId: text(row.reportId, 200),
        status: row.status as 'COMPLETED' | 'FAILED',
        outcome: row.outcome as ServerAutomationReportOutcome,
        sessionId: nullableText(row.sessionId),
        detailCiphertext: nullableText(row.detailCiphertext),
      }
    })
    return { schedules, pendingReports }
  } catch (error) {
    if (error instanceof Error && error.message === 'automation-runtime-invalid') throw error
    invalid()
  }
}

export function createServerAutomationRuntimeStore(options: { filePath: string }): ServerAutomationRuntimeStore {
  return {
    read() {
      try {
        const state = parse(readFileSync(options.filePath, 'utf8'))
        chmodSync(options.filePath, 0o600)
        return state
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schedules: [], pendingReports: [] }
        throw error
      }
    },
    write(state) {
      const validated = parse(JSON.stringify({ version: 1, ...state }))
      mkdirSync(path.dirname(options.filePath), { recursive: true })
      const tmp = `${options.filePath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, ...validated }), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, options.filePath)
      chmodSync(options.filePath, 0o600)
    },
  }
}
