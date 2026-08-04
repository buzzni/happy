/**
 * Scheduled automations 파일 저장소.
 *
 * portRegistry.ts와 같은 경로 주입 팩토리 패턴 — 테스트는 tmpdir 파일을 주입한다.
 * 데몬은 단일 프로세스 단일 실행자라 파일 락은 두지 않는다. 대신 모든 쓰기는
 * "예전에 읽어둔 배열"이 아니라 방금 다시 읽은 최신 파일 위에서 변경한다 —
 * 같은 이벤트 루프에서 직렬화되는 다른 핸들러(RPC·tick)의 쓰기를 덮어쓰지 않게.
 * 읽기는 관대한 파싱(없거나 손상 시 빈 목록), 쓰기는 tmp+rename 원자적 쓰기다.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  MAX_AUTOMATIONS,
  parseScheduledAutomations,
  serializeScheduledAutomations,
  type ScheduledAutomation,
} from './automationDomain'

export interface AutomationStore {
  list(): ScheduledAutomation[]
  /** id가 같은 기존 항목을 교체하거나 새로 추가한다. 상한 초과 추가는 throw. */
  upsert(automation: ScheduledAutomation): void
  remove(id: string): boolean
  replaceAll(automations: readonly ScheduledAutomation[]): void
  /** 한 건만 갱신한다(tick의 이력 기록용). 없으면 null. */
  update(id: string, updater: (automation: ScheduledAutomation) => ScheduledAutomation): ScheduledAutomation | null
}

export interface AutomationStoreOptions {
  filePath: string
}

export function createAutomationStore(opts: AutomationStoreOptions): AutomationStore {
  const read = (): ScheduledAutomation[] => {
    let raw: string
    try {
      raw = readFileSync(opts.filePath, 'utf-8')
    } catch {
      return []
    }
    return parseScheduledAutomations(raw)
  }

  const write = (automations: readonly ScheduledAutomation[]): void => {
    mkdirSync(path.dirname(opts.filePath), { recursive: true })
    const tmp = `${opts.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, serializeScheduledAutomations(automations), 'utf-8')
    renameSync(tmp, opts.filePath)
  }

  return {
    list: read,

    upsert(automation) {
      const automations = read()
      const index = automations.findIndex((entry) => entry.id === automation.id)
      if (index >= 0) {
        automations[index] = automation
      } else {
        if (automations.length >= MAX_AUTOMATIONS) {
          throw new Error(`automation-limit-reached: max ${MAX_AUTOMATIONS}`)
        }
        automations.push(automation)
      }
      write(automations)
    },

    remove(id) {
      const automations = read()
      const next = automations.filter((entry) => entry.id !== id)
      if (next.length === automations.length) return false
      write(next)
      return true
    },

    replaceAll(automations) {
      write(automations)
    },

    update(id, updater) {
      const automations = read()
      const index = automations.findIndex((entry) => entry.id === id)
      const current = index >= 0 ? automations[index] : undefined
      if (current === undefined) return null
      const updated = updater(current)
      automations[index] = updated
      write(automations)
      return updated
    },
  }
}
