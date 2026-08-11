/**
 * Scheduled automations 머신 RPC 핸들러(automation-upsert/remove/list).
 *
 * RpcHandlerManager 없이 순수 함수로 분리해 유닛 테스트한다 — apiMachine은
 * 이 팩토리의 결과를 registerHandler에 그대로 넘긴다. params는 앱발
 * 언트러스트 입력이므로 도메인 파서(parseScheduledAutomation)로만 수용하고,
 * directory는 spawn/파일 RPC와 같은 allowedRoot 검증을 통과해야 한다.
 */

import { validatePath } from '@/modules/common/pathSecurity'

import {
  computeNextRunAt,
  findOversizedUpsertField,
  parseScheduledAutomation,
  type ScheduledAutomation,
} from './automationDomain'
import type { AutomationStore } from './automationStore'

export interface AutomationRpcDeps {
  store: AutomationStore
  allowedRoot: string
  now?: () => number
}

export interface AutomationRpcHandlers {
  upsert: (params: unknown) => Promise<{ automation: ScheduledAutomation }>
  remove: (params: unknown) => Promise<{ ok: true }>
  list: (params: unknown) => Promise<{ automations: ScheduledAutomation[] }>
}

function schedulesEqual(left: ScheduledAutomation['schedule'], right: ScheduledAutomation['schedule']): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'interval' && right.kind === 'interval') return left.minutes === right.minutes
  if (left.kind === 'daily' && right.kind === 'daily') {
    return left.hour === right.hour && left.minute === right.minute
  }
  return false
}

export function createAutomationRpcHandlers(deps: AutomationRpcDeps): AutomationRpcHandlers {
  const now = deps.now ?? Date.now

  return {
    async upsert(params: unknown) {
      const row = params && typeof params === 'object'
        ? (params as Record<string, unknown>).automation
        : undefined
      const parsed = parseScheduledAutomation(row)
      if (!parsed) {
        throw new Error('automation is missing required fields (id/projectId/name/prompt/directory/schedule)')
      }
      const oversized = findOversizedUpsertField(parsed)
      if (oversized) {
        throw new Error(`automation field too large: ${oversized}`)
      }

      const validation = validatePath(parsed.directory, deps.allowedRoot)
      if (!validation.valid) {
        throw new Error(validation.error ?? 'automation directory is outside the allowed root')
      }

      const currentNow = now()
      const existing = deps.store.list().find((automation) => automation.id === parsed.id)
      const clientOwnsNextRunAt = !existing
        || !schedulesEqual(existing.schedule, parsed.schedule)
        || (existing.paused && !parsed.paused)
      const requestedNextRunAt = clientOwnsNextRunAt ? parsed.nextRunAt : existing.nextRunAt
      const automation: ScheduledAutomation = {
        ...parsed,
        directory: validation.resolvedPath!,
        // 실행 이력과 동일 스케줄의 다음 예정은 daemon tick이 소유한다. Desktop이 오래된
        // automation-list 결과로 pause/edit해도 방금 기록된 실행 상태를 되돌리지 않는다.
        // 새 행·스케줄 변경·일시정지 해제만 클라이언트가 계산한 다음 예정을 수용한다.
        runHistory: existing?.runHistory ?? parsed.runHistory,
        // 과거/미지정 nextRunAt으로 저장하면 다음 틱이 즉시 발화한다 —
        // upsert는 항상 "지금 이후의 다음 예정"으로 정규화한다.
        nextRunAt: requestedNextRunAt !== null && requestedNextRunAt > currentNow
          ? requestedNextRunAt
          : computeNextRunAt(parsed.schedule, currentNow),
      }
      deps.store.upsert(automation)
      return { automation }
    },

    async remove(params: unknown) {
      const id = params && typeof params === 'object'
        ? (params as Record<string, unknown>).id
        : undefined
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('id is required')
      }
      deps.store.remove(id)
      return { ok: true as const }
    },

    async list() {
      return { automations: deps.store.list() }
    },
  }
}
