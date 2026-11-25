/**
 * 격리 자동화(automation context)를 계정이 확인되는 시점에 세운다 — 데몬 시작과 떼어 놓는다.
 *
 * 왜: 데몬은 서버에 못 붙어도 오프라인 모드로 떠 있어야 한다. 그런데 이 계정 조회 한 번이
 * 연결 오류로 실패하면 데몬 전체가 FATAL 로 꺼졌다. 잠자기에서 깨자마자 데스크톱이
 * 데몬을 띄우면 DNS 가 아직 없어 그대로 재현된다(2026-11-25, `getaddrinfo ENOTFOUND`).
 *
 * 서버에 닿지 못했거나 서버가 아직 준비되지 않은 응답(5xx, JSON 이 아닌 본문)은 "아직 모름"
 * (null)으로 돌려 다음 틱에 다시 묻는다. 그동안 격리 실행은 닫혀 있다 — 계정을 확인하지
 * 못한 채 여는 경로는 없다. 서버가 거절한 응답(FORBIDDEN 등)은 그대로 던져 기존처럼
 * 시작을 실패시킨다.
 */

import { connectionErrorCode, isConnectivityError } from '@/utils/serverConnectionErrors'

/** The profile endpoint answered, but not as a ready server would (5xx, a body that is not JSON). */
export class AccountProfileUnavailableError extends Error {
  constructor(detail: string) {
    super(`Account profile unavailable: ${detail}`)
    this.name = 'AccountProfileUnavailableError'
  }
}

/** 프로필 조회는 읽기 전용이라 응답이 왔는지 모르는 전송 오류도 다시 물어도 된다. */
function isRetryable(error: unknown): boolean {
  if (error instanceof AccountProfileUnavailableError) return true
  if (error instanceof Error && error.name === 'TimeoutError') return true
  // fetch() rejects only for transport failures: DNS, refused, reset, a redirect it was told to refuse.
  if (error instanceof TypeError && error.message === 'fetch failed') return true
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
        if (!isRetryable(error)) throw error
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

type QuestionWorkerPort = { ready(): Promise<void>; maintain(signal?: AbortSignal): Promise<void> }

/**
 * Builds the host and question worker once an account is known, and not before.
 * `establish` at start lets a refusal fail the start; `retry` on each tick keeps trying and
 * reports a refusal once per distinct message. One build at a time: a stalled tick can be
 * abandoned while its lookup is still pending.
 */
export function createLateAutomationContext<Host, Worker extends QuestionWorkerPort>(input: {
  accountId(): Promise<string | null>
  build(accountId: string): { host: Host; worker: Worker }
  log(message: string): void
}) {
  let built: { host: Host; worker: Worker } | null = null
  let pending: Promise<void> | null = null
  let lastRefusal = ''
  const establish = (): Promise<void> => pending ??= (async () => {
    if (built) return
    const accountId = await input.accountId()
    if (accountId) built = input.build(accountId)
  })().finally(() => { pending = null })
  const worker = () => built?.worker ?? null
  return {
    establish,
    retry: () => establish().then(() => { lastRefusal = '' }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastRefusal) input.log(`[automation-context] Account lookup failed: ${message}`)
      lastRefusal = message
    }),
    host: () => built?.host ?? null,
    worker,
    /** For the question runner, created before the worker may exist; only used once `worker()` is set. */
    questions: {
      ready: () => worker()!.ready(),
      maintain: (signal?: AbortSignal) => worker()!.maintain(signal),
    } satisfies QuestionWorkerPort,
  }
}
