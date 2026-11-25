/**
 * 격리 자동화(automation context)가 쓰는 계정 ID 조회를 데몬 시작과 떼어 놓는다.
 *
 * 왜: 데몬은 서버에 못 붙어도 오프라인 모드로 떠 있어야 한다. 그런데 이 조회 한 번이
 * 연결 오류로 실패하면 데몬 전체가 FATAL 로 꺼졌다. 잠자기에서 깨자마자 데스크톱이
 * 데몬을 띄우면 DNS 가 아직 없어 그대로 재현된다(2026-11-25, `getaddrinfo ENOTFOUND`).
 *
 * 연결 오류만 "아직 모름"(null)으로 돌려 호출자가 다음 틱에 다시 묻게 한다. 그동안 격리
 * 실행은 닫혀 있다 — 계정을 확인하지 못한 채 여는 경로는 없다. 서버가 거절한 응답
 * (FORBIDDEN 등)은 그대로 던져 기존처럼 실패시킨다.
 */

import { connectionErrorCode, isConnectivityError } from '@/utils/serverConnectionErrors'

/** 프로필 조회는 읽기 전용이라 응답이 왔는지 모르는 전송 오류도 다시 물어도 된다. */
function isUnreachable(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true
  const code = connectionErrorCode(error)
  return isConnectivityError(code) || (code?.startsWith('UND_ERR_') ?? false)
}

export function createAutomationContextAccount(input: { lookup: () => Promise<string>; log: (message: string) => void }) {
  let accountId: string | null = null
  let reportedUnreachable = false
  return {
    async get(): Promise<string | null> {
      if (accountId) return accountId
      try {
        accountId = await input.lookup()
      } catch (error) {
        if (!isUnreachable(error)) throw error
        if (!reportedUnreachable) {
          reportedUnreachable = true
          input.log('[automation-context] Account lookup unreachable; isolated automations stay closed until the server answers')
        }
        return null
      }
      return accountId
    },
  }
}
