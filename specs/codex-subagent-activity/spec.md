# Codex 서브 에이전트 활동 — 런타임 Spec

> 작성일: 2026-10-28 / 상태: 런타임 구현 완료(미커밋), 릴리스 승인 대기 / 계획: [plan.md](./plan.md) / 기록: [context.md](./context.md)

## 목표

Codex app-server는 부모 스레드가 띄운 서브 에이전트(자식 스레드)의 알림을 메인 스레드와 같은 연결로 보낸다.
Happy CLI는 이 알림을 메인 대화에 섞지 않는다. 대신 클라이언트가 클로드 서브 에이전트와 같은 방식으로
보여 줄 수 있는 두 가지만 내보낸다.

- 메인 턴 안에서 띄운 자식마다 그 턴에 `CodexAgent` 도구 줄 하나(`tool-call-start` + `tool-call-end`)
- 지금 도는 자식 목록: 세션 메타데이터 `codexSubagentTasks`(클로드 `claudeBackgroundTasks`와 같은 모양)

서브 에이전트를 쓰지 않는 세션의 이벤트와 envelope는 바뀌지 않는다.

## 요구사항

1. **R1 메인 흐름에서 떼어 냄.** threadId가 있고 메인 스레드와 다른 알림은 자식 추적기(`CodexSubagentTracker`)만
   받는다. 메인 스레드가 아직 없으면(시작 전, `/clear` 뒤) 이미 알던 자식과 은퇴한 자식의 알림만 떼어 낸다.
   떼어 낸 알림은 메인 턴 수명주기(`task_started`·`task_complete`, `sendTurnAndWait` 해소, idle 폴백, 비활성
   워치독), 전사(`agent_message`), 미리보기(`agent_message_delta`), 토큰 카운트(`token_count`), 계획·diff,
   MCP 시작 상태표에 닿지 않는다. 자식의 텍스트와 프롬프트는 로그에도 남기지 않는다.
   예외: 자식의 `rawResponse/completed`는 지금처럼 `codex_usage`(자식 `thread_id`)로 내보내 사용량 집계를 지킨다.
   예외: 추적 중인 스레드(R4-2의 계보 판정으로 메인에 닿는 자식·손자)의 `turn/started`·`item/*`·
   `thread/tokenUsage/updated`는 메인 턴의 비활성 워치독을 다시 건다. 부모가 `wait_agent`로 자식만 기다리는 동안
   메인 턴을 멈춘 것으로 보고 끊지 않게 하려는 것이다. 계보 밖·미분류 스레드의 알림은 세지 않는다. 기다리는 메인
   턴이 없을 때와 승인·사용자 입력 요청이 답을 기다리는 동안(워치독 꺼짐)은 지금과 같다.
   서버→클라이언트 요청(승인·사용자 입력), `serverRequest/resolved`, threadId 없는 알림은 기존 경로 그대로다.
   떼어 내기는 Codex 버전과 관계없이 항상 적용한다.
2. **R2 턴을 열거나 되살리지 않음.** 메인 스레드의 부모 쪽 서브 에이전트 항목(`collabAgentToolCall`,
   `subAgentActivity`의 `item/started`·`item/completed`)은 `reopenConsumerLifecycleOnResumedWork`보다 먼저
   가로채 끝난 턴을 다시 열지 않는다. 이 항목은 전에도 전사로 나가지 않았다. 매퍼는 열린 턴이 없으면
   `collab_agent_spawned`에 envelope를 만들지 않고 상태도 그대로 돌려준다. 메인 턴이 닫힌 뒤 이 기능이 만드는
   envelope는 없다.
3. **R3 spawn 줄.** 활성 메인 턴 안에서 자식이 확정되면 그 턴에 envelope 두 개를 같은 `turn`으로 넣는다.
   - 확정 신호는 메인 스레드의 `item/completed`뿐이다. V1은 `collabAgentToolCall`(`tool: spawnAgent`,
     `status: completed`, `receiverThreadIds`), V2는 `subAgentActivity`(`kind: started`, `agentThreadId`).
     `item/started`, `wait`·`sendInput`·`closeAgent`·`resumeAgent`, `interacted`·`completed`·`interrupted`는
     줄을 만들지 않는다. 자식 하나에 한 번만 만든다. 손자(자식이 띄운 자식)는 줄 없이 목록에만 든다.
   - 활성 메인 턴: `sendTurnAndWait`가 기다리는 턴과 항목의 turn id가 같고 그 턴이 아직 끝나지 않았다.
     다른 turn id로 온 항목은 목록만 갱신한다.
   - 줄 제목은 자식 이름(R4-3)을 최대 1.5초 기다려 정하고, 못 받으면 폴백 이름을 쓴다. 기다린 뒤 그 턴이
     끝났거나, app-server 프로세스가 바뀌었거나, 끊기는 중(강제 재시작 포함)이면 줄을 버린다.
   - 이벤트 `collab_agent_spawned { call_id, turn_id, thread_id, label }`를 매퍼가
     `tool-call-start { call, name: 'CodexAgent', title: label, description: label, args: { agent: label } }`와
     `tool-call-end { call }`로 바꾼다. `call`은 자식 threadId다. 기존 wire 필드만 쓰고, envelope `subagent`는
     붙이지 않는다. `backgroundTaskId`도 붙이지 않는다. 클라이언트(Desktop 메신저 채널 포함)는 그 값을 클로드
     백그라운드 실행으로 읽는데, 클로드 실행은 끝나면 요청에 다시 답한다. 코덱스 자식은 그러지 않는다
     (2026-10-28 셀프 리뷰, context D15). 비었거나 문자열이 아닌 값은 없는 것으로 본다. 이름은 `Agent`로 쓰고,
     threadId가 없으면 call id를 새로 만든다(이 경우 클라이언트가 실행 중으로 이을 수 없다).
   - Codex가 R4-4 게이트보다 낮으면 줄을 내지 않는다.
4. **R4 `metadata.codexSubagentTasks` 계약.**
   - **R4-1 모양과 발행.** `{ startedAt: number, available: boolean, tasks: Array<{ taskId: string, label: string,
     kind: 'agent' }> | null }`. `taskId`는 자식 threadId이고 `CodexAgent` 줄의 call id와 같다.
     발행할 때마다 값 전체를 바꾼다(REPLACE). `startedAt`은 그 런타임 프로세스의 첫 발행 시각으로 고정한다.
     서브 에이전트를 한 번도 목록에 올린 적 없는 대화의 메타데이터는 바꾸기 전과 같다. runCodex는 빈 목록이나
     `available: false` 목록을 쓰지 않는다. 쓰는 경우는 둘이다. 이 런타임이 목록을 한 번이라도 쓴 뒤, 그리고 이전 런타임이
     남긴 목록이 메타데이터에 있을 때(그 목록을 비우기 위해)다. 연결 때 코덱스 버전 확인(`codex --version`)은 바꾸기 전처럼
     1회이고, 앱 서버 게이트와 목록 게이트가 그 결과를 함께 쓴다.
     `[available, tasks]`가 바뀔 때만 발행하고, runCodex는 받은 값을 `session.updateMetadata`로 쓰되 같은 값이면
     그대로 둔다. 진행 상황은 메타데이터로만 알리고 대화 메시지로 보내지 않는다.
   - **R4-2 목록에 드는 자식.** 계보가 메인 스레드에 닿는 자식(손자 포함) 가운데 실행 중이고 닫히지 않은 것,
     처음 본 순서로 최대 50개. 계보는 처음 본 스레드마다 보내는 `thread/read`(`includeTurns: false`, 3초 제한,
     실패하면 2초 뒤 1회 재시도)의 `source.subAgent.thread_spawn.parent_thread_id` 또는 `parentThreadId`로
     정한다. 두 번 다 실패하면 메인이나 추적 중인 스레드의 spawn 항목이 그 스레드를 가리킨 경우에만 넣는다.
     Codex 내부 보조 스레드(`source.subAgent`가 `review`·`compact`·`memory_consolidation`·그 밖의 값)와 계보 밖
     스레드는 넣지 않는다(떼어 내기는 그대로 한다). 실행 상태는 아래 [실행 상태표](#실행-상태표)를 따르고,
     표시 중인 자식이 있는 동안 5초마다 `thread/read`로 다시 맞춘다.
   - **R4-3 이름.** `nickname [role]` → `nickname` → V2 `agent_path`의 마지막 조각 → `[role]` → `Agent` 순서로
     정한다. Codex TUI `format_agent_picker_item_name` 규칙에 `agent_path` 단계만 더한 것이다. 앞뒤 공백을 지우고
     200 UTF-16 단위까지 자른다(서로게이트 쌍은 쪼개지 않음).
     자식을 처음 목록에 넣을 때 분류 `thread/read`가 진행 중이면 응답이나 1.5초 가운데 먼저 오는 쪽까지 발행을
     미뤄 이름이 두 번 바뀌어 보이지 않게 한다. 그 사이 끝난 자식은 발행하지 않는다.
   - **R4-4 available 게이트.** 연결 때 `codex --version`이 0.105 이상이면 `available: true`다. 그보다 낮거나 버전을
     읽지 못하면 `{ available: false, tasks: null }`을 한 번 발행한다. `tasks: null`은 `available: false`일 때만
     쓴다. 가용성을 알기 전에는 발행하지 않는다.
5. **R5 서브 에이전트 없는 세션은 그대로.** 서브 에이전트 흔적이 없는 스트림의 클라이언트 이벤트(`subagent_tasks`
   제외)와 envelope(`id`·`time` 제외, 매퍼가 무작위로 만드는 turn id는 처음 나온 순번으로 비교)는 이 작업 전 런타임
   `1.1.10-aplus.360`의 출력과 같다. 더해지는 것은 목록 스냅샷 이벤트(`subagent_tasks`: 빈 목록, 또는 Codex가 낮으면
   `available: false`)뿐이고 envelope를 만들지 않는다. 세션 메타데이터도 그대로다: 목록을 올린 적 없는 대화에는
   `codexSubagentTasks`를 쓰지 않는다(R4-1, D14). 이전 런타임이 남긴 목록이 있을 때만 첫 발행이 그것을 비운다.
6. **R6 끝날 때 비움.** app-server 프로세스 종료, 연결 끊기, 강제 재시작(강제 `turn_aborted`보다 먼저), `/clear`
   (`clearThreadState`)는 목록을 `[]`로 비운다. 그 자식들의 늦은 알림은 계속 메인 흐름 밖으로 떼어 낸다.
   재시작된 app-server에서 resume하면 목록을 새로 시작한다(자식은 죽은 app-server와 함께 사라진다). 새 런타임의
   첫 발행은 이전 런타임이 남긴 목록을 바꾼다. 같은 프로세스·같은 스레드의 중간 `thread/resume`(developer
   instructions·MCP 동기화)과 부모 턴 중단은 목록을 비우지 않는다. 두 경우 모두 Codex에서 자식이 계속 돈다.
7. **R7 실패해도 세션을 해치지 않음.** 새 코드는 잘못된 입력, `thread/read` 실패·무응답, 소비자 예외 어느
   경우에도 throw하지 않고 처리되지 않은 거부(unhandledRejection — 런타임에서는 세션 보관으로 이어진다)를 남기지
   않는다. 메타데이터 쓰기 실패는 경고 로그만 남긴다. 기본 타이머는 프로세스를 붙잡지 않고(unref), 정리(dispose)
   뒤에는 아무 일도 하지 않는다.
8. **R8 60분 턴 종료 정리기 면제.** runCodex는 자식이 1개 이상 든 목록을 메타데이터에 쓰기 직전에
   `session.markLaunchedBackgroundJob()`을 불러, 클로드 `run_in_background` 도구 호출이 켜는 것과 같은 플래그
   `launchedBackgroundJob`을 켠다(쓰기가 실패해도 표시는 남는다). 빈 목록·`null` 목록은 켜지 않는다. 플래그는 턴
   종료 보고에 실리고, 턴 종료 뒤에 켜졌으면 keep-alive 재보고(30초 안)에 실린다. 데몬은 그 런타임이 살아 있는 동안
   이 세션을 60분 턴 종료 정리에서 빼고 24시간 절대 컷으로 미룬다(클로드 백그라운드 launch와 같은 수명). 오프라인
   대체 객체에서는 같은 이름의 no-op이다. 데몬과 클로드 경로는 바꾸지 않는다.

### 실행 상태표

자식마다 실행 중(running)과 닫힘(gone)을 둔다. 목록에는 계보가 맞고 실행 중이며 닫히지 않은 자식만 든다.
스레드 상태 값의 해석(`active` → 실행 중, `notLoaded` → 닫힘)은 Codex TUI picker의 `is_running`·`is_closed` 판정
(`codex-rs/tui/src/app/agent_picker.rs`)과 같다.

| 입력 | 결과 |
|---|---|
| 자식 자신의 `turn/started`, `thread/status/changed` `active` | 실행 중. 닫힘도 푼다 |
| 자식 자신의 `turn/completed`(상태 무관), `thread/status/changed` `idle`·`systemError` | 멈춤 |
| 자식 자신의 `thread/status/changed` `notLoaded`, `thread/closed`·`thread/deleted`·`thread/archived` | 멈춤 + 닫힘 |
| 메인이나 추적 중인 스레드의 `item/completed` `collabAgentToolCall`, `agentsStates[자식].status`: `pendingInit`·`running` / `completed`·`errored`·`interrupted` / `shutdown`·`notFound` | 실행 중 / 멈춤 / 멈춤 + 닫힘 |
| 메인이나 추적 중인 스레드의 `item/completed` `subAgentActivity`, `kind`: `started` / `completed`·`interrupted` / `interacted` | 실행 중 / 멈춤 / 변화 없음 |
| `thread/read` 응답의 `status.type`: `active` / `idle`·`systemError` / `notLoaded` | 실행 중 / 멈춤 / 멈춤 + 닫힘. 요청을 보낸 뒤 더 새 입력이 왔으면 상태는 버리고 이름·계보만 쓴다 |
| R6의 비우는 지점 | 모든 자식을 은퇴시킨다. 은퇴한 id의 알림은 계속 떼어 내지만 다시 추적하지 않는다 |

부모 쪽 항목의 `item/started`는 쓰지 않는다. 닫힘은 자식 자신의 `turn/started`·`active`로만 풀리고 부모 쪽
항목이나 `thread/read` 응답으로는 풀리지 않는다. closeAgent가 끝날 때 app-server가 `notLoaded`를 닫기 직전 상태
(`running`)가 든 항목보다 먼저 보내기 때문이다. 같은 자식이 다시 돌면(`followup_task`·`resume_agent`) 다시
목록에 든다.

## 호환성

- 새 런타임 + 구 Desktop: `codexSubagentTasks`는 무시된다. `CodexAgent` 줄은 일반 도구 줄(즉시 완료)로 보인다.
  떼어 내기(R1·R2)의 효과는 그대로 받는다.
- 구 런타임 + 새 Desktop: 키와 줄이 없어 지금과 같다.
- 새 런타임 + Codex 0.105 미만: 목록을 숨기고(`available: false`) 줄도 내지 않는다. 떼어 내기는 적용한다.
- V1(`multi_agent_version: v1`)과 V2 모두 처리한다(녹음: gpt-5.6-luna V1, gpt-5.6-terra V2).

## 범위

- `packages/happy-cli/src/codex/codexSubagentTracker.ts`(새 모듈)
- `packages/happy-cli/src/codex/codexAppServerClient.ts`: 떼어 내기 게이트, 부모 쪽 항목 가로채기, spawn 이벤트,
  비우는 지점, 연결 때 버전 게이트, 추적 중인 자식 활동의 워치독 반영
- `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`: `collab_agent_spawned` → `CodexAgent` 줄
- `packages/happy-cli/src/codex/runCodex.ts`: `subagent_tasks` → `metadata.codexSubagentTasks`
- `packages/happy-cli/src/api/types.ts`: `Metadata.codexSubagentTasks`
- `packages/happy-cli/src/api/apiSession.ts`: 공개 메서드 `markLaunchedBackgroundJob()`(R8, 주문 05b)
- `packages/happy-cli/src/utils/offlineSessionStub.ts`: 같은 이름의 no-op(R8)
- 녹음 재생 테스트와 fixture: [`__fixtures__/subagent-recordings/`](../../packages/happy-cli/src/codex/__fixtures__/subagent-recordings/README.md),
  [`testing/replayCodexRecording.ts`](../../packages/happy-cli/src/codex/testing/replayCodexRecording.ts)
- 이 문서 세트와 [docs/session-protocol.md](../../docs/session-protocol.md#subagents)의 한 단락

Desktop 표시(세션 flavor로 메타데이터 키 고르기, `CodexAgent` 줄의 아이콘·문구)는 `aplus-dev-studio-desktop`
저장소의 `specs/subagent-running-indicator`(코덱스 요구사항 R11부터)가 맡는다.

## 비목표

- 자식 스레드가 보낸 승인·사용자 입력 요청의 라우팅 변경. 지금처럼 메인 승인 경로로 간다.
- 자식을 멈추는 RPC. 부모 턴 중단은 Codex 설계대로 자식에게 퍼지지 않고, 목록은 그 사실대로 보인다.
- 워치독(턴 비활성 중단)의 기준 시간(10분)과 중단 절차. 추적 중인 자식의 활동을 메인 턴 활동으로 세는 완화는 별도 선택 작업(주문 05)이다. 채택(plan Phase 5)
- 자식의 텍스트·도구 호출을 대화에 보여 주기. 진행 중인지만 보인다.
- Codex app-server의 알림 순서, 메인 스레드 idle이 `turn/completed`보다 먼저 와서 중단된 턴이 `completed`로
  기록되는 기존 문제([context.md](./context.md#열린-문제)).

## 요구사항 ↔ 테스트

새 테스트 187건과 단언을 고친 기존 테스트 1건, 모두 188건이 아래 요구사항 가운데 하나에만 속한다. 경로는
`packages/happy-cli/src/codex/` 기준이다(R8의 `api/`·`utils/` 파일만 `packages/happy-cli/src/` 기준). 괄호 안 숫자는
`it.each` 사례 수다. 재생 테스트는 녹음 6개
(`a-default-terra-v2`, `a-luna-v1`, `b-default-terra-v2`, `b-luna-v1`, `c-default-terra-v2`,
`c-default-terra-v2-retry`)마다 한 번씩 돈다(×6). 한 describe 전체가 한 요구사항에 속하면 describe 이름만 적었다.

| 요구사항 | 건수 |
|---|---|
| R1 | 23 |
| R2 | 3 |
| R3 | 30 |
| R4-1 / R4-2 / R4-3 / R4-4 | 11 / 55 / 17 / 7 |
| R5 | 7 |
| R6 | 13 |
| R7 | 15 |
| R8 | 7 |

### R1
- `codexAppServerClient.test.ts` › `sub-agent thread separation` ›
  - `[1] a child idle status during the main turn leaves the turn open; the main turn/completed settles it (P1)`
  - `[2] a child turn, item, delta and token report reach no event while the main thread is idle (P2, P3)` — 로그에 자식 텍스트가 없는 것도 단언
  - `[3] a child rawResponse/completed still reaches codex_usage, tagged with the child thread`
  - `[4] a child MCP startup report leaves the main MCP status table alone (P6)`
  - `[12] after a fork, the new main thread turn and items flow as before, with thread/started in the answer chunk`
  - `[15] a tracked child reporting every 900 ms keeps the waiting main turn past its 1000 ms inactivity timeout`
  - `[15] reports of a thread %s never count: the main turn is interrupted 1000 ms after its own last report` (3: `outside the main lineage`, `whose thread/read failed twice, with no spawn item naming it`, `whose thread/read is still unanswered`)
  - `[15] once the tracked child goes quiet, the waiting main turn is interrupted 1000 ms after its last report, as before`
  - `[15] a tracked child reporting while an approval waits for the user leaves the watchdog disarmed, as before`
- `codexSubagentReplay.test.ts` › `Codex sub-agent recordings: full stream target` › `<녹음>` ›
  - `full stream: main turn is reported exactly once and never completed by a child` (×6) — `b-default-terra-v2`·`c-default-terra-v2-retry`에서는 R2의 재열림(P4)도 함께 막는다
  - `full stream: child text never reaches the transcript or the stream preview` (×6)

### R2
- `codexAppServerClient.test.ts` › `sub-agent thread separation` › `[7] a V2 subAgentActivity completed after the main turn reopens nothing and reports no row (P4)`
- `__tests__/sessionProtocolMapper.test.ts` › `mapCodexMcpMessageToSessionEnvelopes` › `collab_agent_spawned` ›
  - `adds nothing and changes nothing when no turn is open`
  - `adds nothing once its turn has ended, so nothing follows the turn-end`

### R3
- `codexAppServerClient.test.ts` › `sub-agent thread separation` ›
  - `[5] a V2 spawn in the main turn reports one row on item/completed, labelled from thread/read, once per child`
  - `[6] a V1 spawnAgent completed in the main turn reports one row; wait, sendInput and closeAgent report none` — 로그에 V1 프롬프트가 없는 것도 단언
  - `[8] a spawn item under another turn id reports no row but still lists the child`
  - `[9] a spawn whose label read outlasts the main turn reports no row (%s)` (2: `answered after the turn`, `never answered`)
  - `[9] a spawn whose label read is cut short by a forced app-server restart reports no row`
  - `[10] a failed thread/read still reports one %s row, with the fallback label` (2: `V2`, `V1`)
- `__tests__/sessionProtocolMapper.test.ts` › `mapCodexMcpMessageToSessionEnvelopes` › `collab_agent_spawned` ›
  - `adds one CodexAgent row to the open turn, the child thread as its call id and no background task id`
  - `falls back to the Agent label and a generated call id, and omits a missing child thread id`
  - `treats a label, call id and child thread id that are %s as missing` (2: `not strings`, `empty`)
  - `never ties the row to a session sub-agent, even when the message names a parent call`
- `codexSubagentTracker.test.ts` ›
  - `[3] out-of-order and duplicate notifications` › `returns a spawn only once for the same child`
  - `[11] awaitLabel` 전체 (4)
- `codexSubagentReplay.test.ts` › `Codex sub-agent recordings: full stream target` › `<녹음>` ›
  - `full stream: exactly one collab_agent_spawned event, inside the main turn` (×6)
  - `full stream: exactly one CodexAgent row inside the main turn, none after it` (×6)

### R4-1
- `runCodex.shutdown.test.ts` › `Codex sub-agent list metadata (codexSubagentTasks)` ›
  - `writes nothing while no sub-agent was ever listed: a conversation without one keeps its metadata as before`
  - `writes each published list to the metadata and nothing to the transcript`
  - `leaves the metadata as it is when the same list is published again`
- `codexSubagentTracker.test.ts` ›
  - `[3] out-of-order and duplicate notifications` › `publishes once for the same turn/started delivered twice`
  - `[L] published list` › `republishes when a poll changes a label, and not when the answer changes nothing`
- `codexSubagentReplay.test.ts` › `Codex sub-agent recordings: full stream target` › `<녹음>` › `full stream: subagent_tasks snapshots` (×6) — 자식이 메인 턴보다 오래 도는 녹음(`b-*`, `c-default-terra-v2-retry`)에서는 `[]`가 메인 턴이 끝난 뒤에 온다. R6의 "부모 턴 중단은 비우지 않음"도 `c-default-terra-v2-retry`가 고정한다

### R4-2
- `codexSubagentTracker.test.ts` ›
  - `[1] V2 spawn flow (a-default-terra-v2)` › `reads the new child, confirms the spawn once, and publishes it only while it runs`
  - `[1] V2 spawn flow (a-default-terra-v2)` › `replays the recorded notification order and publishes exactly [] -> [Linnaeus] -> []`
  - `[2] V1 spawn flow (a-luna-v1)` 전체 (3)
  - `[3] out-of-order and duplicate notifications` › `re-enters the list on a late active after turn/completed, until the next poll reads idle`
  - `[3] out-of-order and duplicate notifications` › `shows a child seen only through item notifications from the thread/read status (no turn/started)`
  - `[3] out-of-order and duplicate notifications` › `keeps a newer notification over an older thread/read answer`
  - `[4] classification failure` 전체 (3)
  - `[5] internal helper threads` 전체 (4: `review`, `compact`, `memory_consolidation`, `other`)
  - `[6] grandchildren` 전체 (3)
  - `[7] threads outside the main lineage` 전체 (4)
  - `[T] running-state table (design §1.1)` 전체 (29)
  - `[13] polling and dispose` › `keeps a 5 s timer only while a child is shown, and reads the shown children one at a time`
  - `[13] polling and dispose` › `starts no second round while one is in flight, and schedules the next after it`
  - `[L] published list` › `lists at most 50 running children, first seen first`
  - `[L] published list` › `keeps first-seen order when a child stops and runs again`

### R4-3
- `codexSubagentTracker.test.ts` ›
  - `[1] V2 spawn flow (a-default-terra-v2)` › `rule B: lists the child with the fallback label after 1.5 s without a thread/read answer, then republishes the nickname`
  - `[1] V2 spawn flow (a-default-terra-v2)` › `rule B: publishes nothing for a child that stops while its first listing waits`
  - `[1] V2 spawn flow (a-default-terra-v2)` › `rule B: keeps a child without spawn evidence out of the list until its thread/read answers`
  - `[10] formatCodexAgentLabel (Codex TUI rules)` 전체 (14)

### R4-4
- `codexAppServerClient.test.ts` › `sub-agent thread separation` ›
  - `[13] %s publishes %j once, at connect` (3: `codex-cli 0.104.0`, `codex-cli 0.105.0`, `codex-cli 0.157.1`)
  - ``[13] connects with a single `codex --version` read: the app-server and sub-agent list gates share it``
  - `[13] an app-server too old for the list still keeps child threads out of the main flow, with no spawn row (R13)` — 게이트 아래에서도 R1이 적용되고 R3 줄이 없는 것을 함께 고정
- `codexSubagentTracker.test.ts` › `[9] availability` 전체 (2)

### R5
- `codexSubagentReplay.test.ts` › `Codex sub-agent recordings replayed through CodexAppServerClient and the session mapper` › `<녹음>` › `identity: no-subagent stream reproduces the golden exactly` (×6) — golden은 `.360` 런타임의 출력이다. 스냅샷이 빈 목록(또는 `available: false`)뿐이고 매퍼가 envelope를 만들지 않는 것도 단언
- `codexAppServerClient.test.ts` › `CodexAppServerClient sandbox integration` › `emits response-scoped usage with the native Codex response id` — 기존 테스트. 연결 때의 `subagent_tasks`를 뺀 나머지가 여전히 `codex_usage` 하나뿐이라고 단언을 고쳤다

### R6
- `codexAppServerClient.test.ts` › `sub-agent thread separation` ›
  - `[11] %s publishes an empty list and keeps the old child out of the main flow` (3: `process exit`, `clearThreadState`, `disconnect`)
  - `[11] a forced app-server restart publishes an empty list before the forced turn_aborted, and the old child stays out`
  - `[12] a same-process resume of the same thread keeps a running child listed and tracked`
  - `[12] a resume on a restarted app-server starts the list over and tracks new children`
- `runCodex.shutdown.test.ts` › `Codex sub-agent list metadata (codexSubagentTasks)` ›
  - `replaces a list an earlier runtime left and keeps an identical one as it is`
  - `empties the list on /clear`
- `codexSubagentTracker.test.ts` › `[8] invalidate() and setMainThread(null)` 전체 (5)

### R7
- `codexAppServerClient.test.ts` › `sub-agent thread separation` › `[14] thread/read failing with %s and a throwing consumer leave no unhandled rejection` (2: `an error answer`, `no answer (request timeout)`)
- `runCodex.shutdown.test.ts` › `Codex sub-agent list metadata (codexSubagentTasks)` › `swallows a metadata write that throws`
- `codexSubagentTracker.test.ts` ›
  - `[12] never throws` 전체 (10)
  - `[13] polling and dispose` › `dispose() clears every timer and ignores later answers, notifications and calls`
  - `[13] polling and dispose` › `unrefs its default timers and clears them on dispose`

### R8
- `runCodex.shutdown.test.ts` › `Codex sub-agent turn-end reap exemption (markLaunchedBackgroundJob)` ›
  - `marks the session once a published list holds a running sub-agent`
  - `marks the session even when the list cannot be written to the metadata`
  - `never marks a session whose only list is %s` (2: `an empty list`, `the list of a Codex too old to report sub-agents`)
- `api/apiSession.test.ts` › `ApiSessionClient v3 messages API migration` ›
  - `flags launchedBackgroundJob at turn end once a Codex sub-agent marks the conversation`
  - `sends a mark made after the turn-end report with the next periodic report`
- `utils/offlineSessionStub.test.ts` › `createOfflineSessionStub` › `takes the Codex sub-agent mark as a no-op`
