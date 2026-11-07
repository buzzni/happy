/**
 * aplus-dev-studio specs/scheduled-missed-run-policy R4·R6·R7 — 작업PC가 꺼짐·절전·연결 끊김으로
 * 서버 claim 창(지난 90초)을 넘긴 예약 회차를 센다. 실행기는 이 결과를 서버에 한 행으로 기록하고,
 * 저장이 확인된 뒤에만 일정을 `resumeAt` 으로 넘긴다. 순수 함수라 시계·저장소·전송을 모른다.
 */
import { computeNextRunAt, type AutomationSchedule } from './automationDomain'

/** 서버 claim 창의 과거 쪽 폭(happy-server automationExecutionService). 이보다 오래된 회차는 claim 이 거절된다. */
export const MISSED_RUN_CLAIM_WINDOW_MS = 90_000

/** 한 공백에서 세는 회차 상한. 넘으면 세기를 멈추고 `capped` 로 하한임을 알린다(서버 상한과 같다). */
export const MAX_COUNTED_MISSED_RUNS = 1000

export interface MissedRunPlanInput {
  schedule: AutomationSchedule
  /** 런타임 상태에 남은 이 generation 의 다음 실행 시각 — 놓쳤다면 첫 놓친 회차다. */
  nextRunAt: number
  /** 서버 시계 기준 지금. */
  now: number
  /** 서버가 이 generation 을 실행 가능하게 한 시각. 이전 회차는 이 정의의 회차가 아니다. */
  enabledAt: number
  paused: boolean
  runRequestedAt: number | null | undefined
  /** 직전 회차 세션 때문에 미룬 즉시 실행 요청 시각 — nextRunAt 은 미룬 시각이라 요청과 같지 않다. */
  deferredRunRequestAt?: number
  githubTrigger: boolean
}

export interface MissedRunPlan {
  firstMissedAt: number
  /** 놓친 회차 수, `capped` 면 하한(=MAX_COUNTED_MISSED_RUNS). */
  missedCount: number
  capped: boolean
  /**
   * 놓치지 않은 첫 회차(claim 창 안이거나 미래). 지금 이하면 아직 claim 할 수 있는 회차다.
   * null 이면 남은 회차가 없다(지나간 1회 예약).
   */
  resumeAt: number | null
}

/**
 * 놓친 회차가 없으면 null. 일시정지·즉시 실행 요청·GitHub 트리거·enabledAt 이전·claim 창 안의 지연은
 * 놓침이 아니다(R7). interval 은 산술로, 달력형은 회차를 걸어 센다 — 상한에 걸려도 `resumeAt` 은 잃지 않는다.
 */
export function planMissedRuns(input: MissedRunPlanInput): MissedRunPlan | null {
  const { schedule, nextRunAt, now } = input
  const cutoff = now - MISSED_RUN_CLAIM_WINDOW_MS
  if (input.paused || input.githubTrigger || schedule.kind === 'github') return null
  if (input.runRequestedAt != null
    && (input.runRequestedAt === nextRunAt || input.runRequestedAt === input.deferredRunRequestAt)) return null
  if (!Number.isSafeInteger(nextRunAt) || nextRunAt >= cutoff || nextRunAt < input.enabledAt) return null

  if (schedule.kind === 'interval') {
    const step = schedule.minutes * 60_000
    const total = Math.ceil((cutoff - nextRunAt) / step)
    return {
      firstMissedAt: nextRunAt,
      missedCount: Math.min(total, MAX_COUNTED_MISSED_RUNS),
      capped: total >= MAX_COUNTED_MISSED_RUNS,
      resumeAt: nextRunAt + total * step,
    }
  }

  let missedCount = 1
  let slot = nextRunAt
  while (missedCount < MAX_COUNTED_MISSED_RUNS) {
    const next = computeNextRunAt(schedule, slot)
    if (next === null || next >= cutoff) break
    missedCount += 1
    slot = next
  }
  return {
    firstMissedAt: nextRunAt,
    missedCount,
    capped: missedCount >= MAX_COUNTED_MISSED_RUNS,
    resumeAt: computeNextRunAt(schedule, cutoff - 1),
  }
}
