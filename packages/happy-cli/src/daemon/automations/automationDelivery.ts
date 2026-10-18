/**
 * Sending a scheduled run's result or failure to a paired messenger conversation
 * (Saycode specs/automation-result-delivery — R4~R10, plan D2·D3·D6·D7·D8).
 *
 * The daemon that ran the automation decides; the channel host on the same machine, which owns
 * the messenger connection, sends (`send`, the `deliver` message of the host protocol). This
 * module is the decision: which runs are owed a message, the failure ledger that keeps a repeated
 * failure from alerting on every run, and the fixed wording.
 *
 * Failures are grouped by automation and a closed signature — the run's `failureCode`, with the
 * unreachable-retry suffix taken off, or `TURN_FAILED` for a turn that ended in failure. The first
 * failure of a group alerts; the same group alerts again only once a day has passed since its last
 * alert (hermes `cron/incidents.py` keeps open incidents the same way; its default is six hours).
 * Any success closes the automation's group, and a different signature opens a new one at once.
 *
 * What leaves the machine is the task name, the cut final answer and a closed failure code —
 * never tool output, script text or a free-form error. What is kept on disk is less: automation
 * ids, run ids, signatures and times. The name and the targets are read from the payload again
 * when they are needed (`payloadFor`), so a delivery turned off mid-run is respected.
 *
 * A message is sent at most once per run and kind. The key is recorded before the send and an
 * ambiguous outcome is not retried: a duplicate alert is worse than a missing one here, because
 * the next run is minutes or hours away and says the same thing.
 *
 * One exception: a result the channel host could not take because it was not there — restarting
 * after a crash or an update, or not up yet after the daemon started — is tried again a few times
 * a minute apart. Unlike a failure, which the next failing run alerts again, a result belongs to
 * this run only. The tries live in memory: a daemon restart in between drops them.
 */

import type { AutomationDeliveryTarget } from '@slopus/happy-wire'

import type { AutomationTurnResult } from '@/api/automationTurnTracker'

import type { ServerAutomationPayload } from './serverAutomationCache'

export const AUTOMATION_FAILURE_REPEAT_MS = 24 * 60 * 60_000
/** A scheduled turn longer than this is not waited for. */
const AWAIT_TURN_MS = 6 * 60 * 60_000
const DELIVERED_KEEP_MS = 7 * 24 * 60 * 60_000
const KEPT_ENTRIES_MAX = 200
const TURN_FAILED = 'TURN_FAILED'
const UNKNOWN_FAILURE = 'AUTOMATION_FAILED'
const CLOSED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
/** A turn can end before its run is recorded as started; such results wait this long, in memory. */
const EARLY_RESULT_MS = 5 * 60_000
const EARLY_RESULTS_MAX = 50
/** Covers the host supervisor's restart backoff (up to a minute) a few times over. */
export const AUTOMATION_RESULT_RETRIES = 5
const RESULT_RETRY_MS = 60_000

export interface AutomationFailureIncident {
  signature: string
  firstAt: number
  alertedAt: number
}

export interface AutomationDeliveryState {
  version: 1
  incidents: Record<string, AutomationFailureIncident>
  delivered: Array<{ key: string; at: number }>
  awaiting: Array<{ runId: string; automationId: string; sessionId: string; at: number }>
}

export interface AutomationDeliveryStore {
  read(): AutomationDeliveryState
  write(state: AutomationDeliveryState): void
}

/** The host protocol's `deliver` request body (Desktop `cli/channelHost/daemonBridge.ts`). */
export interface AutomationDeliveryRequest {
  v: 1
  connectionId: string
  grantKey: string
  kind: 'result' | 'failure'
  text: string
  dedupeKey: string
}

/** `unsupported`: no channel host here, or one that predates `deliver`. */
export type AutomationDeliveryOutcome = 'sent' | 'failed' | 'unknown' | 'unsupported'

export function failureSignature(failureCode: string | null | undefined): string {
  const code = failureCode?.replace(/_AFTER_\d+_RETRIES$/, '')
  // Only a closed code is a signature; anything else would also be refused by the ledger.
  return code && CLOSED_CODE.test(code) ? code : UNKNOWN_FAILURE
}

export function decideFailureAlert(
  previous: AutomationFailureIncident | undefined,
  signature: string,
  now: number,
): { decision: 'alert' | 'repeat' | 'withhold'; incident: AutomationFailureIncident } {
  if (!previous || previous.signature !== signature) {
    return { decision: 'alert', incident: { signature, firstAt: now, alertedAt: now } }
  }
  if (now - previous.alertedAt >= AUTOMATION_FAILURE_REPEAT_MS) {
    return { decision: 'repeat', incident: { ...previous, alertedAt: now } }
  }
  return { decision: 'withhold', incident: previous }
}

type Words = {
  failure: (name: string, reason: string) => string
  repeat: (hours: number) => string
  reasons: { turnFailed: string; targetGone: string; preparation: string; generic: string }
}

const WORDS: Record<'en' | 'ko' | 'ja' | 'zh', Words> = {
  en: {
    failure: (name, reason) => `⚠️ Scheduled task "${name}" failed — ${reason}`,
    repeat: (hours) => ` · still failing for the same reason after ${hours}h`,
    reasons: {
      turnFailed: 'the agent could not finish its answer',
      targetGone: 'the conversation it runs in is not available',
      preparation: 'it could not be prepared',
      generic: 'it could not run',
    },
  },
  ko: {
    failure: (name, reason) => `⚠️ 예약 "${name}" 실행 실패 — ${reason}`,
    repeat: (hours) => ` · ${hours}시간째 같은 이유로 실패 중`,
    reasons: {
      turnFailed: '에이전트가 답을 끝내지 못했습니다',
      targetGone: '실행할 대화를 찾지 못했습니다',
      preparation: '실행을 준비하지 못했습니다',
      generic: '실행하지 못했습니다',
    },
  },
  ja: {
    failure: (name, reason) => `⚠️ 予約「${name}」の実行に失敗しました — ${reason}`,
    repeat: (hours) => ` · 同じ理由で${hours}時間失敗が続いています`,
    reasons: {
      turnFailed: 'エージェントが回答を完了できませんでした',
      targetGone: '実行先の会話が見つかりません',
      preparation: '実行の準備ができませんでした',
      generic: '実行できませんでした',
    },
  },
  zh: {
    failure: (name, reason) => `⚠️ 定时任务“${name}”运行失败 — ${reason}`,
    repeat: (hours) => ` · 已因同一原因持续失败 ${hours} 小时`,
    reasons: {
      turnFailed: '代理未能完成回答',
      targetGone: '找不到要运行的对话',
      preparation: '无法准备运行',
      generic: '无法运行',
    },
  },
}

const PREPARATION_CODES = new Set(['GRANT_EXCHANGE_FAILED', 'POLICY_UNSPECIFIED', 'CONVERSATION_POLICY_UNSUPPORTED'])

function wordsFor(locale: string | undefined): Words {
  const language = (locale ?? '').toLowerCase().split(/[-_]/)[0]
  return language === 'ko' || language === 'ja' || language === 'zh' ? WORDS[language] : WORDS.en
}

export function buildAutomationDeliveryText(input:
  | { kind: 'result'; locale?: string; name: string; answer: string }
  | { kind: 'failure'; locale?: string; name: string; code: string; repeatHours?: number },
): string {
  if (input.kind === 'result') return `🗓 ${input.name}\n\n${input.answer}`
  const words = wordsFor(input.locale)
  const reason = input.code === TURN_FAILED ? words.reasons.turnFailed
    : input.code === 'CONVERSATION_TARGET_UNAVAILABLE' ? words.reasons.targetGone
      : PREPARATION_CODES.has(input.code) ? words.reasons.preparation
        : words.reasons.generic
  return `${words.failure(input.name, `${reason} (${input.code})`)}${input.repeatHours ? words.repeat(input.repeatHours) : ''}`
}

function resultTarget(payload: ServerAutomationPayload | null | undefined): AutomationDeliveryTarget | null {
  return payload?.delivery?.result ?? null
}

function failureTarget(payload: ServerAutomationPayload | null | undefined): AutomationDeliveryTarget | null {
  const failure = payload?.delivery?.failure
  return failure === 'same' ? resultTarget(payload) : failure ?? null
}

export interface AutomationDeliveryCoordinator {
  /** A run's failure is final: reported at once, or settled after the unreachable retries gave up. */
  runFailed(input: { automationId: string; runId: string; payload: ServerAutomationPayload; failureCode: string | null }): Promise<AutomationDeliveryOutcome | 'skipped'>
  /** A run started its work. A conversation run is settled later by its turn. */
  runStarted(input: { automationId: string; runId: string; payload: ServerAutomationPayload; sessionId: string | null; awaitsTurn: boolean }): void
  /** The session reported the turn that answered a scheduled prompt. */
  turnFinished(input: { sessionId: string; result: AutomationTurnResult }): Promise<AutomationDeliveryOutcome | 'skipped'>
}

export function createAutomationDeliveryCoordinator(deps: {
  machineId: string
  store: AutomationDeliveryStore
  /** The automation's current payload, or null when it is gone or unreadable. */
  payloadFor(automationId: string): ServerAutomationPayload | null
  send(request: AutomationDeliveryRequest): Promise<AutomationDeliveryOutcome>
  now(): number
  logDebug?(message: string): void
  /** Defaults to an unref'd timer. */
  schedule?(run: () => void, ms: number): void
}): AutomationDeliveryCoordinator {
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.() })
  const update = (change: (state: AutomationDeliveryState) => AutomationDeliveryState) => {
    const now = deps.now()
    const next = change(deps.store.read())
    deps.store.write({
      ...next,
      delivered: next.delivered.filter((entry) => now - entry.at < DELIVERED_KEEP_MS).slice(-KEPT_ENTRIES_MAX),
      awaiting: next.awaiting.filter((entry) => now - entry.at < AWAIT_TURN_MS).slice(-KEPT_ENTRIES_MAX),
    })
  }

  const closeIncident = (automationId: string) => {
    if (!deps.store.read().incidents[automationId]) return
    update((state) => {
      const { [automationId]: _closed, ...incidents } = state.incidents
      return { ...state, incidents }
    })
  }

  const deliver = async (
    target: AutomationDeliveryTarget,
    kind: AutomationDeliveryRequest['kind'],
    runId: string,
    text: string,
  ): Promise<AutomationDeliveryOutcome | 'skipped'> => {
    if (target.machineId !== deps.machineId) {
      deps.logDebug?.(`[automation-delivery] run=${runId} ${kind} skipped: the pairing is on another machine`)
      return 'skipped'
    }
    const dedupeKey = `${runId}:${kind}`
    if (deps.store.read().delivered.some((entry) => entry.key === dedupeKey)) return 'skipped'
    update((state) => ({ ...state, delivered: [...state.delivered, { key: dedupeKey, at: deps.now() }] }))
    let outcome: AutomationDeliveryOutcome
    try {
      outcome = await deps.send({ v: 1, connectionId: target.connectionId, grantKey: target.grantKey, kind, text, dedupeKey })
    } catch {
      outcome = 'unknown'
    }
    deps.logDebug?.(`[automation-delivery] run=${runId} ${kind} ${outcome}`)
    // Definitely not sent: the key is released. Only an ambiguous send keeps it, so it is never repeated.
    if (outcome === 'failed' || outcome === 'unsupported') {
      update((state) => ({ ...state, delivered: state.delivered.filter((entry) => entry.key !== dedupeKey) }))
    }
    return outcome
  }

  const alertFailure = async (
    automationId: string,
    runId: string,
    payload: ServerAutomationPayload | null,
    signature: string,
  ): Promise<AutomationDeliveryOutcome | 'skipped'> => {
    const target = failureTarget(payload)
    if (!payload || !target) return 'skipped'
    const now = deps.now()
    const { decision, incident } = decideFailureAlert(deps.store.read().incidents[automationId], signature, now)
    if (decision === 'withhold') return 'skipped'
    const repeatHours = decision === 'repeat' ? Math.round((now - incident.firstAt) / (60 * 60_000)) : undefined
    const outcome = await deliver(target, 'failure', runId, buildAutomationDeliveryText({
      kind: 'failure', locale: payload.delivery?.locale, name: payload.name, code: signature, repeatHours,
    }))
    // Only an alert that may have reached the person starts the quiet period; an unsent one is retried next failure.
    if (outcome === 'sent' || outcome === 'unknown') {
      update((state) => ({ ...state, incidents: { ...state.incidents, [automationId]: incident } }))
    }
    return outcome
  }

  const finishTurn = async (
    entry: { runId: string; automationId: string },
    result: AutomationTurnResult,
  ): Promise<AutomationDeliveryOutcome | 'skipped'> => {
    if (result.status === 'cancelled') return 'skipped'
    const payload = deps.payloadFor(entry.automationId)
    if (result.status === 'failed') return alertFailure(entry.automationId, entry.runId, payload, TURN_FAILED)
    closeIncident(entry.automationId)
    if (result.silent || !result.finalAnswer) return 'skipped'
    return deliverResult(entry, result.finalAnswer, 0)
  }

  const deliverResult = async (
    entry: { runId: string; automationId: string },
    answer: string,
    retries: number,
  ): Promise<AutomationDeliveryOutcome | 'skipped'> => {
    // Read again on every try, so a delivery turned off in between is respected.
    const payload = deps.payloadFor(entry.automationId)
    const target = resultTarget(payload)
    if (!payload || !target) return 'skipped'
    const outcome = await deliver(target, 'result', entry.runId, buildAutomationDeliveryText({
      kind: 'result', locale: payload.delivery?.locale, name: payload.name, answer,
    }))
    if (outcome === 'unsupported' && retries < AUTOMATION_RESULT_RETRIES) {
      schedule(() => {
        void deliverResult(entry, answer, retries + 1)
          .catch((error) => deps.logDebug?.(`[automation-delivery] run=${entry.runId} result retry not handled: ${error}`))
      }, RESULT_RETRY_MS)
    }
    return outcome
  }

  const early = new Map<string, { sessionId: string; result: AutomationTurnResult; at: number }>()

  return {
    runFailed: ({ automationId, runId, payload, failureCode }) =>
      alertFailure(automationId, runId, payload, failureSignature(failureCode)),

    runStarted({ automationId, runId, payload, sessionId, awaitsTurn }) {
      if (!payload.delivery || !awaitsTurn || !sessionId) {
        closeIncident(automationId)
        return
      }
      const arrived = early.get(runId)
      early.delete(runId)
      if (arrived && arrived.sessionId === sessionId && deps.now() - arrived.at < EARLY_RESULT_MS) {
        void finishTurn({ runId, automationId }, arrived.result)
          .catch((error) => deps.logDebug?.(`[automation-delivery] run=${runId} early result not handled: ${error}`))
        return
      }
      update((state) => ({
        ...state,
        awaiting: [...state.awaiting.filter((entry) => entry.runId !== runId), { runId, automationId, sessionId, at: deps.now() }],
      }))
    },

    async turnFinished({ sessionId, result }) {
      const entry = deps.store.read().awaiting.find((item) => item.runId === result.runId && item.sessionId === sessionId)
      if (!entry) {
        // Possibly a turn that ended before its run was recorded as started; `runStarted` picks it up.
        if (early.size >= EARLY_RESULTS_MAX) early.delete(early.keys().next().value!)
        early.set(result.runId, { sessionId, result, at: deps.now() })
        return 'skipped'
      }
      update((state) => ({ ...state, awaiting: state.awaiting.filter((item) => item.runId !== entry.runId) }))
      return finishTurn(entry, result)
    },
  }
}
