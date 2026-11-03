import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type {
  GithubIssueSnapshot,
  GithubPullRequestSnapshot,
  GithubTriggerEventMatch,
  GithubTriggerIssueEventMatch,
  GithubTriggerRuntimeState,
} from './githubTriggerDomain'

export type ServerAutomationReportOutcome = 'WOKE' | 'SILENT' | 'SKIPPED_GATE' | 'ERROR'

export interface ServerAutomationScheduleState {
  automationId: string
  generation: number
  nextRunAt: number
  lastSessionId: string | null
  runRequestRevision?: number | null
  /**
   * 1회 예약에서 이미 실행한(claim 성공 또는 서버의 같은 회차 거절) 정규 회차 시각. generation 이 바뀌어도
   * 넘긴다 — 서버의 같은 회차 거절은 generation 단위라, 이것 없이는 실행 직후의 편집·재개가 그 회차를
   * 새 generation 으로 다시 claim 한다. 구 데몬 파서는 이 필드를 버릴 뿐 파일을 거부하지 않는다.
   */
  spentOnceAt?: number
}

export interface GithubIssueProgressMarkerState {
  automationId: string
  generation: number
  sessionId: string
  issueNumber: number
  actor: string
  repository: string
  reactionId: number | null
  cleanupRetryAt?: number
}

export interface GithubAutomationWorktreeState {
  automationId: string
  generation: number
  runId: string
  repositoryRoot: string
  worktreePath: string
  directory: string
  sessionId: string | null
  createdAt: number
  cleanupRetryAt?: number
  cleanupAttempts?: number
  /** 수명 상한을 넘겨 종료를 요청한 시각. 매 틱 다시 SIGTERM 을 보내지 않기 위한 표시다. */
  stopRequestedAt?: number
}

export interface PendingAutomationReport {
  runId: string
  claimToken: string
  reportId: string
  status: 'COMPLETED' | 'FAILED'
  outcome: ServerAutomationReportOutcome
  sessionId: string | null
  detailCiphertext: string | null
  failureCode?: string | null
  degradedCode?: string | null
  notificationOnly?: boolean
  queueDepth?: number | null
  queuePosition?: number | null
  queueTotal?: number | null
  queueEstimatedAt?: number | null
  /** When this report was first queued. Absent on entries persisted before this field existed. */
  createdAt?: number
}

/**
 * 모델 호출 전 연결 실패로 보고를 보류하고 재시도를 기다리는 run (automationUnreachableRetry).
 * report 는 재시도를 포기할 때 그대로 보낼 실패 보고다.
 */
export interface UnreachableRetryState {
  /** 이 run 을 붙잡은 데몬 프로세스. 다르면 재시작으로 보고 재시도를 버린다. */
  ownerId: string
  automationId: string
  generation: number
  /** 이미 예약한 재시도 횟수(1부터). */
  attempt: number
  retryAt: number
  /** 서버가 마지막으로 알려 준 run lease 만료 시각. 재시도는 이 안에서 끝나야 한다. */
  leaseExpiresAt: number
  /** 재시도를 포기했고 report 를 서버가 받기를 기다린다. 그동안 같은 자동화의 새 claim 을 미룬다. */
  releasing?: boolean
  report: PendingAutomationReport
}

export interface ServerAutomationRuntimeState {
  schedules: ServerAutomationScheduleState[]
  githubTriggers?: Array<{
    automationId: string
    generation: number
    state: GithubTriggerRuntimeState
  }>
  githubActiveSessions?: Array<{
    automationId: string
    generation: number
    sessionIds: string[]
  }>
  githubQueueProgress?: Array<{
    automationId: string
    generation: number
    total: number
    completed: number
  }>
  githubIssueProgressMarkers?: GithubIssueProgressMarkerState[]
  githubWorktrees?: GithubAutomationWorktreeState[]
  unreachableRetries?: UnreachableRetryState[]
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

function parsePullRequest(value: unknown): GithubPullRequestSnapshot {
  const row = record(value)
  const author = row.author === null ? null : record(row.author)
  if (!Array.isArray(row.labels) || !Array.isArray(row.files) || typeof row.isDraft !== 'boolean') invalid()
  return {
    number: integer(row.number, 1),
    title: text(row.title, 10_000),
    url: text(row.url, 2_000),
    author: author === null ? null : { login: text(author.login, 200) },
    baseRefName: text(row.baseRefName, 512),
    headRefName: text(row.headRefName, 512),
    ...(row.headRefOid === undefined ? {} : { headRefOid: text(row.headRefOid, 64) }),
    isDraft: row.isDraft,
    state: text(row.state, 32),
    mergedAt: nullableText(row.mergedAt),
    labels: row.labels.map((value) => ({ name: text(record(value).name, 200) })),
    changedFiles: integer(row.changedFiles),
    files: row.files.map((value) => ({ path: text(record(value).path, 2_000) })),
  }
}

function parseGithubEvent(value: unknown): GithubTriggerEventMatch {
  const row = record(value)
  if (!['opened', 'ready_for_review', 'merged', 'closed'].includes(row.event as string)) invalid()
  return {
    id: text(row.id, 256),
    event: row.event as GithubTriggerEventMatch['event'],
    pr: parsePullRequest(row.pr),
  }
}

function parseIssue(value: unknown): GithubIssueSnapshot {
  const row = record(value)
  const author = row.author === null ? null : record(row.author)
  if (!Array.isArray(row.labels)) invalid()
  return {
    number: integer(row.number, 1),
    title: text(row.title, 10_000),
    url: text(row.url, 2_000),
    author: author === null ? null : { login: text(author.login, 200) },
    labels: row.labels.map((label) => ({ name: text(record(label).name, 200) })),
  }
}

function parseGithubIssueEvent(value: unknown): GithubTriggerIssueEventMatch {
  const row = record(value)
  if (row.event !== 'issue_opened') invalid()
  return {
    id: text(row.id, 256),
    event: 'issue_opened',
    issue: parseIssue(row.issue),
  }
}

function parseGithubState(value: unknown): GithubTriggerRuntimeState {
  const row = record(value)
  if (!Array.isArray(row.snapshot) || !Array.isArray(row.processed) || !Array.isArray(row.pending)) invalid()
  return {
    snapshot: row.snapshot.map(parsePullRequest),
    highestPrNumber: integer(row.highestPrNumber),
    processed: row.processed.map((value) => text(value, 256)),
    pending: row.pending.map(parseGithubEvent),
    ...(row.highestIssueNumber === undefined ? {} : {
      highestIssueNumber: integer(row.highestIssueNumber),
    }),
    ...(row.pendingIssues === undefined ? {} : {
      pendingIssues: Array.isArray(row.pendingIssues)
        ? row.pendingIssues.map(parseGithubIssueEvent)
        : invalid(),
    }),
  }
}

const REPORT_OUTCOMES = new Set<ServerAutomationReportOutcome>(['WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR'])

function parsePendingReport(value: unknown): PendingAutomationReport {
  const row = record(value)
  if ((row.status !== 'COMPLETED' && row.status !== 'FAILED')
    || !REPORT_OUTCOMES.has(row.outcome as ServerAutomationReportOutcome)) invalid()
  return {
    runId: text(row.runId, 200),
    claimToken: text(row.claimToken),
    reportId: text(row.reportId, 200),
    status: row.status as 'COMPLETED' | 'FAILED',
    outcome: row.outcome as ServerAutomationReportOutcome,
    sessionId: nullableText(row.sessionId),
    detailCiphertext: nullableText(row.detailCiphertext),
    ...(row.failureCode !== undefined ? { failureCode: nullableText(row.failureCode) } : {}),
    ...(row.degradedCode !== undefined ? { degradedCode: nullableText(row.degradedCode) } : {}),
    ...(row.notificationOnly !== undefined ? {
      notificationOnly: row.notificationOnly === true,
    } : {}),
    ...(row.queueDepth !== undefined ? {
      queueDepth: row.queueDepth === null ? null : integer(row.queueDepth),
    } : {}),
    ...(row.queuePosition !== undefined ? {
      queuePosition: row.queuePosition === null ? null : integer(row.queuePosition),
    } : {}),
    ...(row.queueTotal !== undefined ? {
      queueTotal: row.queueTotal === null ? null : integer(row.queueTotal),
    } : {}),
    ...(row.queueEstimatedAt !== undefined ? {
      queueEstimatedAt: row.queueEstimatedAt === null ? null : integer(row.queueEstimatedAt),
    } : {}),
  }
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
        ...(row.runRequestRevision !== undefined ? {
          runRequestRevision: row.runRequestRevision === null
            ? null
            : integer(row.runRequestRevision, 1),
        } : {}),
        ...(row.spentOnceAt !== undefined ? { spentOnceAt: integer(row.spentOnceAt) } : {}),
      }
    })
    const pendingReports = disk.pendingReports.map(parsePendingReport)
    const githubRows = disk.githubTriggers === undefined ? [] : disk.githubTriggers
    if (!Array.isArray(githubRows)) invalid()
    const githubTriggers = githubRows.map((value) => {
      const row = record(value)
      return {
        automationId: text(row.automationId, 200),
        generation: integer(row.generation, 1),
        state: parseGithubState(row.state),
      }
    })
    const activeRows = disk.githubActiveSessions === undefined ? [] : disk.githubActiveSessions
    if (!Array.isArray(activeRows)) invalid()
    const githubActiveSessions = activeRows.map((value) => {
      const row = record(value)
      if (!Array.isArray(row.sessionIds)) invalid()
      return {
        automationId: text(row.automationId, 200),
        generation: integer(row.generation, 1),
        sessionIds: row.sessionIds.map((value) => text(value, 200)),
      }
    })
    const progressRows = disk.githubQueueProgress === undefined ? [] : disk.githubQueueProgress
    if (!Array.isArray(progressRows)) invalid()
    const githubQueueProgress = progressRows.map((value) => {
      const row = record(value)
      const total = integer(row.total)
      const completed = integer(row.completed)
      if (completed > total) invalid()
      return {
        automationId: text(row.automationId, 200),
        generation: integer(row.generation, 1),
        total,
        completed,
      }
    })
    const markerRows = disk.githubIssueProgressMarkers === undefined ? [] : disk.githubIssueProgressMarkers
    if (!Array.isArray(markerRows)) invalid()
    const githubIssueProgressMarkers = markerRows.map((value) => {
      const row = record(value)
      return {
        automationId: text(row.automationId, 200),
        generation: integer(row.generation, 1),
        sessionId: text(row.sessionId, 200),
        issueNumber: integer(row.issueNumber, 1),
        actor: text(row.actor, 200),
        repository: text(row.repository, 512),
        reactionId: row.reactionId === null ? null : integer(row.reactionId, 1),
        ...(row.cleanupRetryAt === undefined ? {} : {
          cleanupRetryAt: integer(row.cleanupRetryAt),
        }),
      }
    })
    const worktreeRows = disk.githubWorktrees === undefined ? [] : disk.githubWorktrees
    if (!Array.isArray(worktreeRows)) invalid()
    const githubWorktrees = worktreeRows.map((value) => {
      const row = record(value)
      return {
        automationId: text(row.automationId, 200),
        generation: integer(row.generation, 1),
        runId: text(row.runId, 200),
        repositoryRoot: text(row.repositoryRoot, 4_096),
        worktreePath: text(row.worktreePath, 4_096),
        directory: text(row.directory, 4_096),
        sessionId: nullableText(row.sessionId),
        createdAt: integer(row.createdAt),
        ...(row.cleanupRetryAt === undefined ? {} : {
          cleanupRetryAt: integer(row.cleanupRetryAt),
        }),
        ...(row.cleanupAttempts === undefined ? {} : {
          cleanupAttempts: integer(row.cleanupAttempts),
        }),
      }
    })
    const retryRows = disk.unreachableRetries === undefined ? [] : disk.unreachableRetries
    if (!Array.isArray(retryRows)) invalid()
    const unreachableRetries = retryRows.map((value) => {
      const row = record(value)
      return {
        ownerId: text(row.ownerId, 200),
        automationId: text(row.automationId, 200),
        generation: integer(row.generation, 1),
        attempt: integer(row.attempt, 1),
        retryAt: integer(row.retryAt),
        leaseExpiresAt: integer(row.leaseExpiresAt),
        ...(row.releasing === true ? { releasing: true } : {}),
        report: parsePendingReport(row.report),
      }
    })
    return {
      schedules, githubTriggers, githubActiveSessions, githubQueueProgress,
      githubIssueProgressMarkers, githubWorktrees, unreachableRetries, pendingReports,
    }
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
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return {
            schedules: [], githubTriggers: [], githubActiveSessions: [], githubQueueProgress: [],
            githubIssueProgressMarkers: [], githubWorktrees: [], unreachableRetries: [], pendingReports: [],
          }
        }
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
