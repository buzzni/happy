/**
 * 모델 호출 전에 네트워크로 실패한 예약 실행을 같은 run 으로 약 1·2·4분 뒤 다시 시도한다.
 *
 * 설계 참고: hermes-agent `cron/unreachable_retry.py` (MIT, Nous Research). 그대로 옮기지
 * 않고 서버 claim/run 계약에 맞춰 다시 썼다 — specs/automation-unreachable-retry.
 *
 * 왜 같은 run 을 붙잡는가: 서버는 claim 시각이 now±90초 밖이면 거절하고, FAILED 보고는
 * 곧바로 실패 이력이 되며 Desktop 은 최근 3회 실패를 보면 예약을 자동 일시정지한다.
 * 실패를 보고하지 않고 run 을 RUNNING 으로 잡아 둔 채(heartbeat) 같은 runId·claimToken
 * 으로 다시 시도하면 서버 이력에 행이 하나만 남고, 실패는 마지막에 한 번만 기록된다.
 *
 * 왜 lease 안에서 끝내는가: 서버는 lease(start·heartbeat 응답의 runLeaseExpiresAt)가 지난
 * run 의 heartbeat·사전 단계를 모두 거절한다. 그래서 재시도 시각은 서버가 준 만료 시각에서
 * 틱 지연 여유를 뺀 시각을 넘지 않는다 (사용자 결정으로 hermes 의 5·15·30분에서 축소).
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

/** 각 실패 시각에서 다음 재시도까지. 첫 실패 기준 누적 약 1·2·4분. */
export const UNREACHABLE_RETRY_DELAYS_MS = [60_000, 60_000, 120_000] as const

/**
 * 재시도 시각과 lease 만료 사이에 두는 여유. 재시도는 그 시각 뒤 첫 데몬 틱(기본 60초 간격)에
 * 돌고, 사전 단계 요청(권한 교환 시간 제한 3초)과 데몬·서버 시계 차이를 더해 30초를 얹었다.
 */
export const UNREACHABLE_RETRY_LEASE_MARGIN_MS = 90_000

/** 서버 failureCode 규칙 (happy-server automationSocketHandler). */
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

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

/** start·heartbeat 응답의 lease 만료 시각. 서버는 epoch ms 로 보낸다. 없거나 읽을 수 없으면 null. */
export function runLeaseExpiresAt(value: unknown): number | null {
  const raw = value && typeof value === 'object' ? (value as { runLeaseExpiresAt?: unknown }).runLeaseExpiresAt : undefined
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 재시도 끝에 기록하는 실패 코드. 이력에서 재시도였음과 횟수가 보이도록 원래 코드 뒤에
 * `_AFTER_<n>_RETRIES` 를 붙인다. 화면은 failureCode 를 그대로 보여 주고 코드별 분기가 없다.
 */
export function unreachableRetryFailureCode(code: string | null | undefined, retries: number): string | null {
  if (!code) return null
  const marked = `${code}_AFTER_${retries}_RETRIES`
  return retries > 0 && FAILURE_CODE_PATTERN.test(marked) ? marked : code
}

function withRetryCount(report: PendingAutomationReport, retries: number): PendingAutomationReport {
  return { ...report, failureCode: unreachableRetryFailureCode(report.failureCode, retries) }
}

/**
 * 다음 재시도 시각. 재시도를 다 썼거나, lease 안에 넣을 수 없거나, 그 시각이 다음 정규
 * 실행과 같거나 늦으면 null — 마지막 경우에는 정규 실행이 곧 재시도다.
 */
export function planUnreachableRetry(input: {
  attempt: number
  now: number
  nextRegularRunAt: number
  leaseExpiresAt: number | null
}): number | null {
  const delay = UNREACHABLE_RETRY_DELAYS_MS[input.attempt]
  if (delay === undefined || input.leaseExpiresAt === null) return null
  const retryAt = Math.min(input.now + delay, input.leaseExpiresAt - UNREACHABLE_RETRY_LEASE_MARGIN_MS)
  return retryAt > input.now && retryAt < input.nextRegularRunAt ? retryAt : null
}

/**
 * 붙잡은 실패를 재시도로 바꿀 수 있으면 저장하고 true 를 돌려준다. false 면 호출부가
 * 평소처럼 보고한다 — 이미 재시도를 거쳤다면 failureCode 에 그 횟수를 붙여서
 * (unreachableRetryFailureCode).
 */
export function holdUnreachableRetry(
  runtimeStore: ServerAutomationRuntimeStore,
  input: {
    automation: EncryptedServerAutomation
    report: PendingAutomationReport
    attempt: number
    now: number
    leaseExpiresAt: number | null
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
    leaseExpiresAt: input.leaseExpiresAt,
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
    leaseExpiresAt: input.leaseExpiresAt!,
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
 * 틱마다 붙잡은 run 을 정리한다. 재시도를 더 기다릴 수 없는 것은 마감 대상(releasing)으로
 * 표시하고 보낼 실패 보고에 재시도 횟수를 붙인다 — 서버가 그 보고를 받을 때까지 항목은
 * 남아 같은 자동화의 새 claim 을 막는다(settleReleasedUnreachableRetries 가 보낸다).
 * 기다리는 것은 lease 를 잇고, 서버가 준 새 만료 시각을 기억한다.
 */
export function maintainUnreachableRetries(input: {
  runtimeStore: ServerAutomationRuntimeStore
  automations: EncryptedServerAutomation[]
  now: number
  heartbeat: (run: { runId: string; claimToken: string }) => Promise<{ ok: boolean; value?: unknown }>
  logDebug?: (message: string) => void
}): void {
  const state = input.runtimeStore.read()
  const held = state.unreachableRetries ?? []
  let changed = false
  const next = held.map((entry): UnreachableRetryState => {
    if (entry.releasing) return entry
    const automation = input.automations.find((item) => item.automationId === entry.automationId)
    const schedule = state.schedules.find((item) => item.automationId === entry.automationId)
    const reason = entry.ownerId !== UNREACHABLE_RETRY_OWNER ? 'the daemon restarted'
      : !automation ? 'the automation was removed'
        : automation.paused || automation.migrationPending === true ? 'the automation was paused'
          : automation.generation !== entry.generation ? 'the automation was edited'
            : !schedule || schedule.nextRunAt <= input.now ? 'a regular run is due'
              : entry.leaseExpiresAt <= input.now ? 'the run lease ran out'
                : null
    if (reason) {
      input.logDebug?.(
        `[server-automation] run=${entry.report.runId} discarding pending unreachable retry`
        + ` ${entry.attempt}/${UNREACHABLE_RETRY_DELAYS_MS.length} because ${reason}; recording the failure`,
      )
      changed = true
      // attempt 는 예약해 둔 재시도 번호다 — 실제로 돈 재시도는 그보다 하나 적다.
      return { ...entry, releasing: true, report: withRetryCount(entry.report, entry.attempt - 1) }
    }
    // 시각이 지났어도 잇는다 — 이전 세션이 아직 돌면 재시도가 다음 틱으로 밀린다.
    // 실패는 버린다: lease 가 끊기면 재시도가 lease 만료 사유로 마감된다. 기다리지 않는다 —
    // 소켓이 끊긴 동안 ack 를 기다리면 틱 전체가 멈춘다.
    void input.heartbeat({ runId: entry.report.runId, claimToken: entry.report.claimToken })
      .then((result) => {
        const leaseExpiresAt = result.ok ? runLeaseExpiresAt(result.value) : null
        if (leaseExpiresAt !== null) rememberLease(input.runtimeStore, entry.report.runId, leaseExpiresAt)
      })
      .catch((error) => input.logDebug?.(`[server-automation] held run heartbeat failed: ${error}`))
    return entry
  })
  if (changed) input.runtimeStore.write({ ...state, unreachableRetries: next })
}

function rememberLease(runtimeStore: ServerAutomationRuntimeStore, runId: string, leaseExpiresAt: number): void {
  const state = runtimeStore.read()
  const entries = state.unreachableRetries ?? []
  if (!entries.some((item) => item.report.runId === runId && !item.releasing)) return
  runtimeStore.write({
    ...state,
    unreachableRetries: entries.map((item) => item.report.runId === runId
      ? { ...item, leaseExpiresAt: Math.max(item.leaseExpiresAt, leaseExpiresAt) }
      : item),
  })
}

/** 서버에 보낼 보류 실패 보고. 보내기는 실행기가 한다(보고 거절 분류는 실행기 몫). */
export function releasedUnreachableRetries(state: ServerAutomationRuntimeState): UnreachableRetryState[] {
  return (state.unreachableRetries ?? []).filter((item) => item.releasing)
}

/** 서버가 보류 실패를 받았거나 영구히 거절했다 — 항목을 지운다. */
export function forgetUnreachableRetry(runtimeStore: ServerAutomationRuntimeStore, runId: string): void {
  const state = runtimeStore.read()
  runtimeStore.write({
    ...state,
    unreachableRetries: (state.unreachableRetries ?? []).filter((item) => item.report.runId !== runId),
  })
}

/**
 * 이 자동화가 마감을 확인받지 못한 보류 run 을 갖고 있다. 서버에서는 그 run 이 아직
 * RUNNING 이라 새 claim 이 active-run 으로 거절되고, 그러면 실행기가 정규 회차를 넘긴다.
 */
export function hasUnsettledUnreachableRetry(state: ServerAutomationRuntimeState, automationId: string): boolean {
  return (state.unreachableRetries ?? []).some((item) => item.automationId === automationId && item.releasing)
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
      && !item.releasing
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
