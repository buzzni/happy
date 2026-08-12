/**
 * HAPPY_INITIAL_PROMPT — daemon spawn(initialPrompt 옵션)이 전달한 첫 사용자
 * 프롬프트를 원격 세션에서 정확히 한 번 소비한다 (scheduled automations 등).
 *
 * 배달은 두 경로를 모두 만족해야 한다:
 * (a) 턴 시작 — messageQueue에 push해 에이전트가 이 프롬프트로 첫 턴을 연다.
 * (b) 서버 히스토리 — 앱발 프롬프트는 앱이 서버에 먼저 쓰지만 이 프롬프트는
 *     어디에도 없다. 데몬은 세션 콘텐츠 키가 없어 못 쓰므로, 키를 가진 세션
 *     프로세스가 직접 sendClaudeSessionMessage로 user 레코드를 보낸다 — 원격
 *     스캐너가 터미널발 프롬프트를 앱에 보이게 하는 것과 같은 메커니즘이다.
 *     스캐너의 자동 포워딩에 기대지 않는 이유: onSessionHook이
 *     treatExistingAsProcessed로 세션 시작 시점의 JSONL 내용을 전부 처리된
 *     것으로 마킹하므로, SDK가 먼저 쓴 첫 프롬프트는 포워딩되지 않을 수 있다.
 *     대신 recordAppPrompt로 스탬프해 스캐너가 SDK의 JSONL 기록을 이중
 *     포워딩하지 않게 한다(앱발 프롬프트와 동일한 dedupe 규약).
 */

import { appendClaudeTitleInstruction } from './utils/titlePrompt'
import type { RawJSONLines } from './types'
import {
  buildInitialPromptUserRecord,
  consumePendingInitialPrompt,
} from '@/utils/initialPrompt'

export {
  buildInitialPromptUserRecord,
  consumePendingInitialPrompt,
} from '@/utils/initialPrompt'

export interface InitialPromptSink {
  sessionId: string | null
  hasTitle(): boolean
  sendClaudeSessionMessage(record: RawJSONLines): void
  recordAppPrompt(text: string): void
  pushPrompt(text: string): void
}

export type PreparedClaudeInitialPrompt = {
  prompt: string | null
  exitAfterFirstTurn: boolean
}

export function prepareClaudeInitialPrompt(input: {
  env: NodeJS.ProcessEnv
  reconnectSessionId?: string
  automationRunOnceRequested: boolean
}): PreparedClaudeInitialPrompt {
  const consumedPrompt = consumePendingInitialPrompt(input.env)
  const prompt = consumedPrompt && !input.reconnectSessionId ? consumedPrompt : null

  if (input.automationRunOnceRequested && !prompt) {
    throw new Error('Claude automation cannot start without a fresh initial prompt')
  }

  return {
    prompt,
    exitAfterFirstTurn: input.automationRunOnceRequested && prompt !== null,
  }
}

export async function deliverPreparedClaudeSessionStart(input: {
  prepared: PreparedClaudeInitialPrompt
  sink: InitialPromptSink
  reportStarted?: () => Promise<void>
}): Promise<boolean> {
  const prompt = input.prepared.prompt
  input.prepared.prompt = null
  if (prompt) {
    deliverInitialPrompt(prompt, input.sink)
  }
  await input.reportStarted?.()
  return prompt !== null
}

export function deliverInitialPrompt(prompt: string, sink: InitialPromptSink): void {
  // (b) 서버 히스토리: 원문 그대로 — 앱은 이 레코드로 사용자 말풍선을 그린다.
  sink.sendClaudeSessionMessage(buildInitialPromptUserRecord(prompt, sink.sessionId))
  // SDK가 곧 같은 텍스트를 JSONL에 쓴다 — 스캐너 이중 포워딩 방지 스탬프.
  sink.recordAppPrompt(prompt)

  // (a) 턴 시작. 새 세션엔 제목이 없으므로 onUserMessage와 동일하게 모델 사본에만
  // 제목 지시를 덧붙이고, 변형본도 dedupe 스탬프한다.
  let pushText = prompt
  if (!sink.hasTitle()) {
    const withTitle = appendClaudeTitleInstruction(pushText)
    if (withTitle !== pushText) {
      pushText = withTitle
      sink.recordAppPrompt(pushText)
    }
  }
  sink.pushPrompt(pushText)
}
