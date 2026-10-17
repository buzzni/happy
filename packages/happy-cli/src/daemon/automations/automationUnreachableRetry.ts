/**
 * 모델 호출 전에 네트워크로 실패한 예약 실행을 5·15·30분 뒤 같은 run 으로 다시 시도한다.
 *
 * 설계 참고: hermes-agent `cron/unreachable_retry.py` (MIT, Nous Research). 그대로 옮기지
 * 않고 서버 claim/run 계약에 맞춰 다시 썼다 — specs/automation-unreachable-retry.
 *
 * 왜 같은 run 을 붙잡는가: 서버는 claim 시각이 now±90초 밖이면 거절하고, FAILED 보고는
 * 곧바로 실패 이력이 되며 Desktop 은 최근 3회 실패를 보면 예약을 자동 일시정지한다.
 * 실패를 보고하지 않고 run 을 RUNNING 으로 잡아 둔 채(heartbeat) 같은 runId·claimToken
 * 으로 다시 시도하면 서버 이력에 행이 하나만 남고, 실패는 마지막에 한 번만 기록된다.
 *
 * 재시도 대상은 좁다: 프롬프트가 세션에 닿기 전 단계(MCP 호출 권한 교환, 대화 대상 확인)
 * 가 연결성 오류로 실패한 경우뿐이다. 스크립트 조건을 이미 실행한 자동화와 GitHub
 * 트리거는 제외한다 — 앞은 사용자 코드가 이미 돌았고, 뒤는 매 틱 스스로 폴링한다.
 */

import { randomUUID } from 'node:crypto'

import { connectionErrorCode, isConnectivityError } from '@/utils/serverConnectionErrors'

import type { EncryptedServerAutomation } from './serverAutomationCache'
import type {
  PendingAutomationReport,
  ServerAutomationRuntimeState,
  ServerAutomationRuntimeStore,
  UnreachableRetryState,
} from './serverAutomationRuntimeStore'

export const UNREACHABLE_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000] as const

/**
 * 이 데몬 프로세스의 표식. 재시작한 데몬은 이전 프로세스가 붙잡던 run 의 heartbeat 를
 * 이어받지 못했으므로(lease 가 끊겼을 수 있다), 그 재시도를 이어 가지 않고 보류한
 * 실패 보고를 그대로 보낸다 (spec R4).
 */
export const UNREACHABLE_RETRY_OWNER = randomUUID()

// undici fetch 가 cause 에 싣는 연결 실패 코드. serverConnectionErrors 목록은 axios·Node
// 소켓 코드라 이 둘이 없다.
const UNDICI_CONNECTIVITY_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])

/**
 * fetch 가 던진 값이 "상대에 닿지 못함" 이면 그 코드를, 아니면 null 을 돌려준다.
 * 호출부가 건 시간 제한(AbortSignal.timeout·AbortController)도 응답이 없었던 것이므로 포함한다.
 */
export function unreachableFetchFailure(error: unknown): string | null {
  const code = connectionErrorCode(error)
  if (isConnectivityError(code) || (code !== undefined && UNDICI_CONNECTIVITY_CODES.has(code))) return code!
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
  return name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : null
}

/** 게이트웨이가 뒤 서버에 닿지 못했다는 응답. 앱이 판단해 거절한 4xx·500 은 포함하지 않는다. */
export function unreachableHttpStatus(status: number): string | null {
  return status === 502 || status === 503 || status === 504 ? `HTTP_${status}` : null
}

/**
 * 다음 재시도 시각. 재시도를 다 썼거나 그 시각이 다음 정규 실행과 같거나 늦으면 null —
 * 그때는 정규 실행이 곧 재시도다.
 */
export function planUnreachableRetry(input: {
  attempt: number
  now: number
  nextRegularRunAt: number
}): number | null {
  const delay = UNREACHABLE_RETRY_DELAYS_MS[input.attempt]
  if (delay === undefined) return null
  const retryAt = input.now + delay
  return retryAt < input.nextRegularRunAt ? retryAt : null
}

/**
 * 붙잡은 실패를 재시도로 바꿀 수 있으면 저장하고 true 를 돌려준다. false 면 호출부가
 * 평소처럼 보고한다.
 */
export function holdUnreachableRetry(
  runtimeStore: ServerAutomationRuntimeStore,
  input: {
    automation: EncryptedServerAutomation
    report: PendingAutomationReport
    attempt: number
    now: number
    logDebug?: (message: string) => void
  },
): boolean {
  const state = runtimeStore.read()
  const schedule = state.schedules.find((item) => item.automationId === input.automation.automationId)
  if (!schedule || input.automation.paused) return false
  const retryAt = planUnreachableRetry({
    attempt: input.attempt,
    now: input.now,
    nextRegularRunAt: schedule.nextRunAt,
  })
  if (retryAt === null) {
    if (input.attempt > 0) {
      input.logDebug?.(
        `[server-automation] run=${input.report.runId} unreachable after ${input.attempt} automatic retries;`
        + ' recording the failure and waiting for the next regular run',
      )
    }
    return false
  }
  const entry: UnreachableRetryState = {
    ownerId: UNREACHABLE_RETRY_OWNER,
    automationId: input.automation.automationId,
    generation: input.automation.generation,
    attempt: input.attempt + 1,
    retryAt,
    report: input.report,
  }
  runtimeStore.write({
    ...state,
    unreachableRetries: [
      ...(state.unreachableRetries ?? []).filter((item) => item.report.runId !== input.report.runId),
      entry,
    ],
  })
  input.logDebug?.(
    `[server-automation] run=${input.report.runId} automation=${input.automation.automationId}`
    + ` unreachable before the prompt was delivered (${input.report.failureCode ?? 'ERROR'});`
    + ` retry ${entry.attempt}/${UNREACHABLE_RETRY_DELAYS_MS.length} at ${new Date(retryAt).toISOString()}`,
  )
  return true
}

/**
 * 틱마다 붙잡은 run 을 정리한다. 재시도를 더 기다릴 수 없는 것은 보류한 실패 보고를
 * pendingReports 로 넘겨 기존 실패 경로로 한 번만 기록하고, 기다리는 것은 lease 를 잇는다.
 * 넘긴 것이 있으면 true — 호출부는 claim 전에 pendingReports 를 보낸다.
 */
export function maintainUnreachableRetries(input: {
  runtimeStore: ServerAutomationRuntimeStore
  automations: EncryptedServerAutomation[]
  now: number
  heartbeat: (run: { runId: string; claimToken: string }) => Promise<unknown>
  logDebug?: (message: string) => void
}): boolean {
  const state = input.runtimeStore.read()
  const held = state.unreachableRetries ?? []
  if (held.length === 0) return false
  const kept: UnreachableRetryState[] = []
  const released: PendingAutomationReport[] = []
  for (const entry of held) {
    const automation = input.automations.find((item) => item.automationId === entry.automationId)
    const schedule = state.schedules.find((item) => item.automationId === entry.automationId)
    const reason = entry.ownerId !== UNREACHABLE_RETRY_OWNER ? 'the daemon restarted'
      : !automation ? 'the automation was removed'
        : automation.paused || automation.migrationPending === true ? 'the automation was paused'
          : automation.generation !== entry.generation ? 'the automation was edited'
            : !schedule || schedule.nextRunAt <= input.now ? 'a regular run is due'
              : null
    if (reason) {
      input.logDebug?.(
        `[server-automation] run=${entry.report.runId} discarding pending unreachable retry`
        + ` ${entry.attempt}/${UNREACHABLE_RETRY_DELAYS_MS.length} because ${reason}; recording the failure`,
      )
      released.push(entry.report)
      continue
    }
    kept.push(entry)
    // 시각이 지났어도 잇는다 — 이전 세션이 아직 돌면 재시도가 다음 틱으로 밀린다.
    // 실패는 버린다: lease 가 끊기면 재시도의 사전 단계가 서버에서 거절되고, 그 거절은
    // 네트워크 오류가 아니므로 최종 실패로 기록된다.
    void input.heartbeat({ runId: entry.report.runId, claimToken: entry.report.claimToken })
      .catch((error) => input.logDebug?.(`[server-automation] held run heartbeat failed: ${error}`))
  }
  if (released.length === 0) return false
  input.runtimeStore.write({
    ...state,
    unreachableRetries: kept,
    pendingReports: [...state.pendingReports, ...released],
  })
  return true
}

function findDueRetry(
  state: ServerAutomationRuntimeState,
  automation: EncryptedServerAutomation,
  now: number,
): UnreachableRetryState | undefined {
  return (state.unreachableRetries ?? []).find((item) => (
    item.automationId === automation.automationId
      && item.generation === automation.generation
      && item.ownerId === UNREACHABLE_RETRY_OWNER
      && item.retryAt <= now
  ))
}

export function hasDueUnreachableRetry(
  state: ServerAutomationRuntimeState,
  automation: EncryptedServerAutomation,
  now: number,
): boolean {
  return findDueRetry(state, automation, now) !== undefined
}

/** 시각이 된 재시도를 꺼낸다. 꺼낸 뒤 다시 실패하면 holdUnreachableRetry 가 새로 저장한다. */
export function takeDueUnreachableRetry(
  runtimeStore: ServerAutomationRuntimeStore,
  automation: EncryptedServerAutomation,
  now: number,
  logDebug?: (message: string) => void,
): UnreachableRetryState | null {
  const state = runtimeStore.read()
  const entry = findDueRetry(state, automation, now)
  if (!entry) return null
  runtimeStore.write({
    ...state,
    unreachableRetries: (state.unreachableRetries ?? []).filter((item) => item.report.runId !== entry.report.runId),
  })
  logDebug?.(
    `[server-automation] run=${entry.report.runId} automation=${automation.automationId}`
    + ` unreachable retry ${entry.attempt}/${UNREACHABLE_RETRY_DELAYS_MS.length}: running the same run again`,
  )
  return entry
}

/** 재시도로 세션을 띄웠을 때는 정규 주기를 재시도 시각 기준으로 밀지 않고 세션만 기록한다. */
export function rememberRetrySession(
  runtimeStore: ServerAutomationRuntimeStore,
  automationId: string,
  sessionId: string,
): void {
  const state = runtimeStore.read()
  runtimeStore.write({
    ...state,
    schedules: state.schedules.map((item) => item.automationId === automationId
      ? { ...item, lastSessionId: sessionId }
      : item),
  })
}
