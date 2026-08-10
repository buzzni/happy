/**
 * Scheduled automations 틱 — due 자동화 하나하나를 claim → 게이트 → spawn으로
 * 실행하는 순수 async 함수. 의존성(store·스크립트 실행·세션 spawn·실행 중 판정)은
 * 전부 주입받는다(sessionIdleReaper의 tick 패턴). 배선·타이머는 후속 작업의
 * run.ts 몫이다.
 *
 * v1(데스크탑 automationRun.ts) 의미론 유지:
 * - 스크립트 실패는 게이트 판정 없이 error(fail-closed) — 부분 stdout으로 게이트를
 *   통과시키면 반쯤 실패한 스크립트가 세션을 깨우거나 조용히 삼킨다(R10).
 * - claim은 실행 전에 store에 반영한다 — 실행 도중 데몬이 죽어도 재기동이 같은
 *   due를 소급 실행하지 않는다.
 * - 직전 woke 세션이 아직 실행 중이면 겹침 실행하지 않는다(R5).
 */

import {
  appendRunRecord,
  buildAutomationPrompt,
  claimDueAutomation,
  isAutomationDue,
  SCRIPT_TIMEOUT_MS,
  shouldWakeFromScriptOutput,
  type AutomationAgent,
  type AutomationRunOutcome,
  type ScheduledAutomation,
} from './automationDomain'
import type { AutomationStore } from './automationStore'

export interface AutomationTickInput {
  store: AutomationStore
  now: number
  runScript: (input: { command: string; cwd: string; timeout: number }) => Promise<{ ok: boolean; stdout: string; error?: string }>
  spawnSession: (input: { directory: string; initialPrompt: string; createdByAccountId: string | null; agent: AutomationAgent }) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>
  isSessionRunning: (sessionId: string) => boolean
  logDebug?: (message: string) => void
}

export interface AutomationTickOutcome {
  id: string
  outcome: AutomationRunOutcome
}

export async function runAutomationTick(input: AutomationTickInput): Promise<AutomationTickOutcome[]> {
  const outcomes: AutomationTickOutcome[] = []
  const dueIds = input.store.list()
    .filter((automation) => isAutomationDue(automation, input.now))
    .map((automation) => automation.id)

  for (const id of dueIds) {
    // 한 자동화의 실패(주입된 deps의 throw 포함)가 나머지 처리를 막지 않는다.
    try {
      // claim은 방금 다시 읽은 최신 목록 위에서 — 앞선 자동화 처리가 store를
      // 바꿨을 수 있다. due가 아니게 됐으면(일시정지 등) 조용히 건너뛴다.
      const claim = claimDueAutomation(input.store.list(), id, input.now)
      if (!claim) continue
      input.store.replaceAll(claim.automations)

      const result = await runClaimedAutomation(claim.claimed, input)
      recordOutcome(input, id, result)
      outcomes.push({ id, outcome: result.outcome })
    } catch (error) {
      input.logDebug?.(`[automation-tick] ${id} threw: ${failureMessage(error)}`)
      try {
        recordOutcome(input, id, { outcome: 'error', sessionId: null })
      } catch {
        // 이력 기록 실패까지 다른 자동화를 막지 않는다.
      }
      outcomes.push({ id, outcome: 'error' })
    }
  }
  return outcomes
}

interface ClaimedRunResult {
  outcome: AutomationRunOutcome
  sessionId: string | null
}

async function runClaimedAutomation(
  automation: ScheduledAutomation,
  input: AutomationTickInput,
): Promise<ClaimedRunResult> {
  // 겹침 가드(R5): 직전 woke 세션이 아직 일하는 중이면 새 세션을 얹지 않는다.
  // 기록이 실행 중인 세션을 가리켜야 사용자가 겹침 스킵의 원인을 찾을 수 있다.
  const runningSessionId = findRunningWokeSessionId(automation, input.isSessionRunning)
  if (runningSessionId !== null) {
    return { outcome: 'skipped-overlap', sessionId: runningSessionId }
  }

  let scriptOutput: string | null = null
  if (automation.scriptCommand) {
    const script = await input.runScript({
      command: automation.scriptCommand,
      cwd: automation.directory,
      timeout: SCRIPT_TIMEOUT_MS,
    })
    if (!script.ok) {
      input.logDebug?.(`[automation-tick] ${automation.id} script failed: ${script.error ?? 'script-failed'}`)
      return { outcome: 'error', sessionId: null }
    }
    if (!shouldWakeFromScriptOutput(script.stdout)) {
      return { outcome: 'skipped-gate', sessionId: null }
    }
    scriptOutput = script.stdout
  }

  const spawned = await input.spawnSession({
    directory: automation.directory,
    initialPrompt: buildAutomationPrompt(automation.prompt, scriptOutput),
    // 세션은 데몬 소유자 자격증명으로 뜨지만 귀속(누가 등록했나)은 남긴다.
    createdByAccountId: automation.createdByAccountId ?? null,
    agent: automation.agent ?? 'claude',
  })
  if (!spawned.ok) {
    input.logDebug?.(`[automation-tick] ${automation.id} spawn failed: ${spawned.error}`)
    return { outcome: 'error', sessionId: null }
  }
  return { outcome: 'woke', sessionId: spawned.sessionId }
}

function findRunningWokeSessionId(
  automation: ScheduledAutomation,
  isSessionRunning: (sessionId: string) => boolean,
): string | null {
  const lastWoke = automation.runHistory.find((record) => record.outcome === 'woke')
  if (!lastWoke?.sessionId) return null
  return isSessionRunning(lastWoke.sessionId) ? lastWoke.sessionId : null
}

function recordOutcome(input: AutomationTickInput, id: string, result: ClaimedRunResult): void {
  // appendRunRecord 경유 — 최신순 이력 + 연속 error 3회 자동 일시정지(R9·R10).
  input.store.update(id, (automation) =>
    appendRunRecord(automation, { at: input.now, outcome: result.outcome, sessionId: result.sessionId }))
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
