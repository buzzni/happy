/**
 * 하트비트에서 automation tick을 detach 실행하는 러너.
 *
 * tick 안의 spawnSession은 세션 webhook을 최대 60초까지 기다린다 — 하트비트가
 * 이를 await하면 due 개수만큼 직렬 대기가 쌓여 하트비트의 나머지 임무(좀비
 * sweep, 자가 업그레이드 감지, 데몬 상태 기록)가 막히고 heartbeatRunning
 * 가드가 다음 틱 전체를 스킵시킨다. 그래서 fire-and-forget으로 띄우되,
 * 자체 리엔트런시 가드로 이전 tick이 아직 도는 동안의 중복 기동만 막는다.
 * 스킵돼도 due는 유실되지 않는다 — claim(nextRunAt 전진)은 실행 직전에야
 * store에 반영되므로, 스킵된 due는 다음 기회의 tick이 그대로 집어간다.
 */

export interface AutomationTickRunner {
  /** 이전 실행이 진행 중이면 스킵하고, 아니면 tick을 detach로 시작한다. */
  trigger(): void
  isRunning(): boolean
  pause(): void
  resume(options?: { trigger?: boolean }): void
}

export function createAutomationTickRunner(opts: {
  runTick: () => Promise<unknown>
  logDebug?: (message: string) => void
  /**
   * 이 시간을 넘긴 tick 은 멈춘 것으로 보고 가드를 풀어 다음 하트비트가 새 tick 을
   * 시작하게 한다. 없으면 이전 tick 이 끝날 때까지 무한히 기다린다 — 2026-10-22·10-24 에
   * 그 대기가 데몬 재시작 전까지 이어져 GitHub 트리거·예약이 조용히 멈췄다.
   */
  stalledAfterMs?: number
  now?: () => number
}): AutomationTickRunner {
  const now = opts.now ?? Date.now
  let running = false
  let paused = false
  let startedAt = 0
  // 버려진 tick 이 뒤늦게 끝나며 지금 도는 tick 의 가드를 풀지 못하게 한다.
  let generation = 0
  const runner: AutomationTickRunner = {
    isRunning: () => running,
    pause() {
      paused = true
    },
    resume(options) {
      paused = false
      if (options?.trigger) runner.trigger()
    },
    trigger() {
      if (paused) {
        opts.logDebug?.('[automation-tick] runner paused; skipping this heartbeat')
        return
      }
      if (running) {
        const elapsedMs = now() - startedAt
        const elapsed = `${Math.round(elapsedMs / 1000)}s`
        if (opts.stalledAfterMs === undefined || elapsedMs < opts.stalledAfterMs) {
          opts.logDebug?.(`[automation-tick] previous tick still running for ${elapsed}; skipping this heartbeat`)
          return
        }
        // 예외는 가드를 풀지만, 끝나지 않는 await 는 아무것도 풀지 않는다. 그 tick 은 버리고
        // 소리 내어 새로 시작한다 — 조용히 영구 정지하는 것보다 낫다.
        opts.logDebug?.(`[automation-tick] tick stalled for ${elapsed}; abandoning it and starting a new tick`)
      }
      running = true
      startedAt = now()
      const mine = ++generation
      // detach: 하트비트를 막지 않는다. 실패는 로그만 — 가드는 항상 해제해
      // 한 번의 예외가 자동화를 영구 정지시키지 않게 한다.
      void Promise.resolve()
        .then(() => opts.runTick())
        .catch((error) => {
          opts.logDebug?.(`[automation-tick] tick failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          if (mine === generation) running = false
        })
    },
  }
  return runner
}
