---
기능: codex-subagent-activity
상태: 런타임 구현·문서 커밋과 출시 전 실앱 검증 완료 — PR·릴리스는 사용자 지시 대기
마지막 갱신: 2026-10-29
---

# Codex 서브 에이전트 활동 — 런타임 Context

## 현재 상태

- 브랜치 `ernie/codex-subagent-activity`. 기준 커밋 `346fe458`(`.362` 릴리스, 2026-10-28 원격 main과 같음).
  `a8e0ddac`(`.360`)에서 fast-forward했고, 그사이 들어온 11개 파일은 이 작업 파일과 겹치지 않는다.
- 주문 01~05·05b 구현과 이 문서 세트를 로컬 커밋 2개(구조 `emitCodexUsage()` 추출 → 기능)로 남겼다. 출시 전 실앱
  검증(2026-10-28, 개인 공간·buzzni)에서 찾은 줄 빠짐을 D16 커밋으로 고쳤다. push·PR·버전 bump·태그·발행은 하지
  않았다. 실앱 검증 기록은 Desktop 작업트리 `.aplus/verification/evidence/20261028-codex-subagent-real/RESULTS.md`.
- 2026-10-29 Fable 검수(`.work/reviews/postreal-r15-d16-review.md`, D16·출시 점검표 번호): pass-with-fixes. 권장 F1을
  D16 보완으로 고쳤고, 점검표 번호는 `.365`로 맞췄다(사용자 승인으로 커밋 dc9f3121, push 안 함).
- 요구사항 R1~R8과 테스트 대응은 [spec.md](./spec.md), 단계별 내용과 검증은 [plan.md](./plan.md)에 있다.
- 주문 05(워치독 완화)는 2026-10-28 사용자가 채택해 구현했다(아래 열린 문제 7, plan Phase 5).
- 주문 05b(60분 정리기 면제)는 2026-10-28 사용자가 채택해 구현했다(아래 열린 문제 6, plan Phase 5b).
- Desktop 표시는 `aplus-dev-studio-desktop` 브랜치 `ernie/subagent-running-indicator`에서 따로 진행한다(주문 07~10).

## 결정 로그

- **D1 메타데이터 키 `codexSubagentTasks`.** 모양은 `claudeBackgroundTasks`와 같게 두어 Desktop 파서를 그대로 쓴다
  (`kind`는 늘 `agent`). `claudeBackgroundTasks`를 재사용하면 Desktop 변경이 없어지지만 기각했다. 키 이름이 사실과
  달라지고, 나중에 Claude 전용 동작(예: 중지 RPC)이 그 키에 묶이면 코덱스 세션이 잘못 걸린다. 키는 Desktop 쪽에서
  세션 `flavor`로 고른다(주문 07).
- **D2 도구 이름 `CodexAgent`.** 기존 `CodexBash`·`CodexPatch`와 같은 관례다. `Agent`(클로드와 같은 이름이라 Desktop
  매핑이 필요 없음)는 제공자 구분이 사라져 기각했다.
- **D3 줄 모양.** 자식 하나에 줄 하나(`tool-call-start` 바로 뒤 `tool-call-end`). 실행 중·완료는 Desktop이
  줄의 call id가 목록에 있는지로 판단한다. 자식 threadId는 그 call id(화면에 그리지 않는 전송 값)로만 나간다
  (D15에서 `backgroundTaskId` 대신). 완료 배지는 없다. 클로드 완료 알림에 해당하는 코덱스 신호가 없어서다.
  트리거는 `item/completed`만 쓴다(Codex 0.140~0.145는 completed만 보낸다).
- **D4 이름.** Codex TUI `format_agent_picker_item_name`(`codex-rs/tui/src/multi_agents.rs`)의 `nickname [role]` →
  `nickname` → `[role]` → `Agent`에, `[role]` 앞 단계로 V2 `agent_path` 마지막 조각을 더했다. `thread/read`가 늦거나
  실패해도 V2 spawn 항목의 `agentPath`(예 `/root/ok_reply` → `ok_reply`)로 이름을 댈 수 있다. 녹음의 `agentRole`은
  모두 null이었다.
- **D5 자식 식별.** Codex TUI가 `thread/loaded/list`를 spawn 트리로 걷는 기준
  (`codex-rs/tui/src/app/loaded_threads.rs`: `SessionSource::SubAgent(ThreadSpawn { parent_thread_id })`를 따라감)을
  처음 본 스레드마다 `thread/read` 한 번으로 적용한다. `thread/loaded/list`는 쓰지 않는다. 끝난 자식도 그 목록에 남고,
  자식 알림이 늘 먼저 온다.
- **D6 실행 상태.** spec의 실행 상태표. 스레드 상태 해석은 TUI picker(`codex-rs/tui/src/app/agent_picker.rs`)와 같다.
  닫힘은 자식 자신의 다음 `turn/started`·`active`로만 푼다. closeAgent가 끝날 때 `notLoaded`가 닫기 직전 상태
  (`running`)를 담은 항목보다 먼저 와서, 부모 쪽 항목으로 풀면 닫힌 자식이 실행 중으로 남는다. `thread/read` 응답의
  상태는 요청 뒤 더 새 입력이 없을 때만 쓴다. 폴링이 턴 경계와 겹칠 때 낡은 응답이 최신 알림을 덮지 않게 하려는
  것이다. 계보는 저장하지 않고 매번 따라가므로, 손자 응답이 부모보다 먼저 와도 부모의 분류를 따른다.
- **D7 첫 등장 지연(규칙 B).** 녹음에서 자식 `turn/started`가 분류 `thread/read` 응답보다 약 100ms 먼저 온다. 바로
  발행하면 폴백 이름으로 한 번, nickname으로 한 번 더 나가 Desktop의 이름이 깜빡인다. 그래서 응답이나 1.5초까지 첫
  발행을 미룬다. spawn 줄 제목도 같은 1.5초를 기다려 줄과 목록이 같은 이름을 쓴다. 첫 읽기가 실패하면 기다리지
  않는다(D16).
- **D8 목록을 새로 시작하는 때.** 메인 스레드 id가 바뀌거나 app-server 프로세스가 바뀐 뒤 첫 start/resume에서만이다.
  runCodex는 같은 프로세스에서 같은 id로 `thread/resume`을 부른다(developer instructions·MCP 동기화). Codex는 이미
  로드된 스레드의 resume을 그 세션에 넘겨 자식이 계속 돌게 한다(Codex
  `codex-rs/app-server/src/request_processors/thread_processor.rs`의 `RunningThreadResumeResult::Handled`). 이때 비우면
  거짓 "완료"가 된다.
- **D9 버전 게이트 0.105.** 자식 알림 자동 구독(0.81), `thread/read`의 `source`(0.94), `thread/status/changed`(0.105)가
  모두 있는 버전이다. 미만이면 목록을 숨기고(`available: false`) spawn 줄도 내지 않는다. Desktop은 `available: false`일
  때 빈 목록을 쓰므로, 줄을 내면 자식이 도는데도 처음부터 "완료"로 보인다. 떼어 내기는 0.81~0.104에도 자식 알림이
  오므로 버전과 관계없이 한다.
- **D10 강제 재시작 창.** `abortTurnWithFallback`의 강제 재시작은 `turn_aborted(forced_restart)`를 보낸 뒤에도 재개가
  끝날 때까지 기다리는 턴을 남긴다. 이름 대기 뒤 재확인에 "끊기는 중인 app-server" 검사를 더해, 그 사이 줄이 턴
  종료 뒤에 나가지 않게 했다.
- **D11 `rawResponse/completed`는 통과.** 떼어 낸 스레드의 것도 `codex_usage`(자식 `thread_id`)로 내보내 비용 집계를
  지킨다. 응답 id가 달라 중복되지 않는다. 메인 워치독의 활동으로는 전처럼 세지 않는다.
- **D12 메타데이터 쓰기.** runCodex는 `updateMetadata` 콜백 안에서 지금 값과 비교해 같으면 그대로 돌려준다. 쓰기
  큐가 콜백을 더 새 메타데이터에 다시 적용할 때를 위한 장치다. `getMetadata()`로 미리 비교해 호출을 건너뛰는 방식은
  기각했다. 그 값은 서버 확인 뒤에야 바뀌어서, 큐에 남은 `[자식]` 쓰기 뒤에 온 `[]`를 같은 값으로 잘못 보고 버리면
  목록이 남는다. 트래커가 바뀔 때만 발행하고 `startedAt`이 프로세스 동안 고정이라, 실제 쓰기는 목록이 바뀔 때뿐이다.
  런타임 시작 때의 빈 목록은 D14 조건에서만 쓴다.
- **D14 목록이 없던 대화는 그대로(2026-10-28 셀프 리뷰).** "서브 에이전트를 안 쓰는 대화는 바꾸기 전과 같다"를
  메타데이터와 연결 비용까지 지키려고 두 가지를 고쳤다.
  - 연결 때 `codex --version` 실행은 1회로 되돌렸다. 앱 서버 게이트와 목록 게이트가 그 결과를 함께 쓴다. 실행 1회가
    이 맥에서 0.13~0.18초 동안 이벤트 루프를 막는 동기 호출이라, 모든 코덱스 대화의 연결에 그만큼 더해지고 있었다.
  - runCodex는 빈 목록이나 `available: false` 목록을 쓰지 않는다. 예외는 둘이다: 이 런타임이 목록을 한 번이라도 쓴
    뒤(`codexSubagentListWritten`), 그리고 메타데이터에 이전 런타임이 남긴 목록이 있을 때다.
  - D12가 기각한 `getMetadata()` 경합은 여기 해당하지 않는다. 그 값을 보는 건 이 런타임이 아직 아무것도 쓰지 않았을
    때뿐이라, 큐에 남은 이 런타임의 쓰기가 없다.
- **D15 `CodexAgent` 줄은 `backgroundTaskId` 대신 call id로 자식을 가리킨다(2026-10-28 셀프 리뷰 2라운드).**
  - 문제: `backgroundTaskId`는 Desktop에서 "끝나면 요청에 다시 답하는 클로드 백그라운드 실행"이라는 뜻이다. 그래서
    이 런타임을 받은 옛 Desktop의 메신저 채널은 코덱스 채널 턴의 답을 보낸 뒤에도 이어지는 답을 기다리며 연결을
    남긴다. 다시 열기에 실패하면 이미 답한 요청을 `unknown`으로 정리한다.
  - 런타임은 작업PC에서 npm 최신판으로 따로 업데이트되므로, 새 Desktop의 채널 예외만으로는 막을 수 없다.
  - 그래서 줄의 call id를 자식 threadId로 하고 `backgroundTaskId`는 붙이지 않는다. 옛 Desktop은 이 줄을 보통
    도구 줄로 보고(전과 같음) 채널 동작도 그대로다. 새 Desktop은 `CodexAgent` 줄에서만 call id로 목록을 찾는다.
  - 기각: `args`에 threadId 넣기(펼친 줄에 기술 값이 보임), 새 wire 필드(strict 스키마와 옛 Desktop 호환 문제),
    채널 턴에서만 빼기(새 Desktop에서 줄이 "완료"인데 맨 아래 줄은 "실행 중"이라 어긋남).
- **D16 첫 `thread/read`가 실패하면 이름을 기다리지 않는다(2026-10-28 실앱 검증, 사용자 승인).**
  - 문제: Codex가 자식 rollout 파일을 쓰기 전이면 첫 읽기가 실패한다(`failed to read session metadata`). 재시도는 2초
    뒤라 1.5초 대기 안에 이름이 오지 않는데, 줄은 대기를 다 채운 뒤 턴을 확인한다. 부모가 띄우고 바로 답하면 그 사이
    턴이 끝나 줄이 버려졌다(GPT-6 Luna, buzzni 조직, 내장 서브 에이전트 8번 중 1번). 맨 아래 줄·목록은 정상이었다.
  - 결정: 첫 읽기가 실패해 재시도를 걸 때 그 자식의 이름 대기를 바로 끝낸다. 줄과 첫 목록은 폴백 이름(V2 경로 조각,
    없으면 `Agent`)으로 곧바로 나간다. 읽기가 성공하는 평소 경로는 바뀌지 않는다.
  - 남는 것: 재시도가 nickname을 받으면 목록(맨 아래 줄) 이름만 바뀌고 줄 제목은 폴백 그대로라 둘이 다를 수 있다
    (예: `lion_sleep` / `Locke`). 사용자가 2026-10-28 "그대로 두기"로 수용했다(열린 문제 12).
  - 기각: 대기를 재시도 뒤까지 늘리기(줄이 늦어지고, 그 사이 턴이 끝나면 여전히 버려진다), 턴이 끝난 뒤에도 줄
    내기(끝난 턴을 다시 여는 문제 — D15와 같은 이유로 옛 Desktop 호환이 깨진다).
  - 보완(2026-10-29 Fable 검수 F1): 위 결정은 실패 시점에 이미 있던 대기만 끝냈다. 실패가 메인의 spawn 항목보다 먼저
    오면 그 항목이 만든 줄 대기·첫 목록 대기는 다시 1.5초를 기다려, 턴이 빨리 끝나면 줄이 버려지고 목록도 늦었다(R3·R4-3과
    어긋남). 자식에 `readFailed`를 두어 첫 실패를 기억하고, 그 뒤 대기도 바로 답한다. 테스트 `[10] reports the row and
    the listing of a child whose first thread/read failed before its spawn item`은 수정 전에 실패했다(5ms 시점 목록 비어
    있음). 성공 경로와 재시도 뒤 동작은 그대로다.
- **D13 매퍼 방어.** 이름이 비었거나 문자열이 아니면 `Agent`로 쓴다. call id는 자식 threadId를 쓰고(D15), threadId가
  없으면 받은 call id, 그것도 없으면 새로 만든다. 실제 경로의 이름 함수는 빈 값을 내지 않는다. envelope `subagent`는 쓰지 않는다. 자식의 내용을 보내지
  않으므로 세션 서브에이전트 매핑 표에 흔적을 남길 이유가 없다.

## 실측 요약 — Codex app-server 0.157.1 녹음 6건

2026-10-28 01:44~01:55 KST에 `codex app-server --listen stdio://`(`-c mcp_servers={} -c features.hooks=false
-c features.plugins=false -c features.memories=false`, 빈 임시 cwd, `thread/start { ephemeral: true, sandbox:
'read-only', approvalPolicy: 'never' }`)로 녹음했다. 사용자가 승인한 6회 한도 안이었다. 개인정보를 지운 사본과 파일별
설명은 [fixture README](../../packages/happy-cli/src/codex/__fixtures__/subagent-recordings/README.md)에 있다.

| 녹음 | 멀티 에이전트 | 장면 | 자식 이름 |
|---|---|---|---|
| `a-default-terra-v2` | V2(gpt-5.6-terra, 기본) | 자식 하나를 띄우고 기다린 뒤 `DONE` | Linnaeus |
| `a-luna-v1` | V1(gpt-5.6-luna) | 위와 같음 | Plato |
| `b-default-terra-v2` | V2 | 느린 자식을 띄우고 기다리지 않고 `SPAWNED`로 턴 종료 | Hume |
| `b-luna-v1` | V1 | 위와 같음 | Mencius |
| `c-default-terra-v2` | V2 | 부모 턴 중단 첫 시도(자식이 먼저 끝나 의도한 장면 아님) | Epicurus |
| `c-default-terra-v2-retry` | V2 | 자식이 도는 중에 부모 `turn/interrupt` | Bohr |

- 자식의 첫 알림은 spawn 항목보다 먼저 오는 `thread/status/changed idle`이다(부모 턴 중).
- 부모 턴이 끝난 뒤에도 자식 알림(델타, `turn/completed`)이 계속 온다. V2는 그 뒤 이미 끝난 부모 턴 id로
  `subAgentActivity completed`를 보낸다. V1에는 부모 쪽 완료 항목이 없다(자식 `turn/completed`·`idle`만).
- 부모 중단은 자식에게 퍼지지 않는다(`c-default-terra-v2-retry`: 부모 7.0초 중단, 자식 13.9초까지 돌고 완료).
- `rawResponse/completed`는 6회 모두 한 번도 오지 않았다.
- 메인 턴이 끝날 때 `thread/status/changed idle`이 `turn/completed`보다 먼저 온다.
- `thread/loaded/list`에는 끝난 자식도 남는다. 승인 요청은 한 번도 오지 않았다.

### 작업 전 런타임(`.360`)에서 재현된 문제

| # | 문제 | 처리 |
|---|---|---|
| P1 | 자식의 첫 `idle`이 스레드를 보지 않는 idle 폴백에 걸려, 자식이 생기는 순간 메인 턴이 `completed`로 닫힘(턴이 둘로 쪼개짐) | R1 |
| P2 | 자식 `turn/started`·`turn/completed`가 메인 턴처럼 처리되어 자식의 답이 새 어시스턴트 턴으로 전송됨 | R1 |
| P3 | 자식 텍스트 델타가 메인 미리보기로 흐름 | R1 |
| P4 | V2 부모 `subAgentActivity completed`가 끝난 턴 id로 와서 턴을 다시 열고 닫지 않음("응답 중"이 다음 메시지까지 켜짐) | R2 |
| P5 | 자식 토큰 사용량이 메인 `token_count`로 나감(지금은 매퍼가 버려 화면 영향 없음) | R1 |
| P6 | 자식 MCP 시작 상태가 메인 MCP 상태표를 덮어씀 | R1 |
| P7 | 부모 턴 중단이 자식에게 퍼지지 않음(Codex 설계) | 바꾸지 않음. 목록이 사실대로 보인다 |

## 검증 명령·결과

공식 명령은 `corepack pnpm -C packages/happy-cli exec …`이다. unit 프로젝트의 globalSetup이 `dist`를 지우고 다시
빌드하므로 공식 명령은 동시에 돌리지 않는다. 반복 실행은 unit 프로젝트 설정에서 globalSetup만 뺀 임시 설정으로 했다.
아래 표의 공식 수치는 주문 02~05b 작업 보고서에서 옮겼고, 문서 작성 때 다시 돌리지 않았다. 같은 파일이 여러 단계에
나오면 마지막 단계의 수치가 현재 값이다.

| 명령 | 결과 | 단계 |
|---|---|---|
| `tsc --noEmit` | 오류 0 | 주문 02·03·04·05·05b, 2026-10-28 문서 작성 때 다시 실행 |
| `vitest run --project unit src/codex/codexSubagentTracker.test.ts` | 98 passed | 주문 02, 05 |
| `… src/codex/codexAppServerClient.test.ts` | 187 passed → 193 passed → 194 passed | 주문 03·04 → 05 → 2026-10-28 셀프 리뷰(연결 때 버전 확인 1회) |
| `… src/codex/codexSubagentReplay.test.ts` | 36 passed, skip 0 | 주문 04, 05, 05b |
| `… src/codex/__tests__/sessionProtocolMapper.test.ts` | 23 passed | 주문 04 |
| `… src/codex/runCodex.shutdown.test.ts` | 43 passed → 47 passed → 48 passed | 주문 04 → 05b(검수 수정 뒤) → 2026-10-28 셀프 리뷰(목록이 없던 대화는 빈 목록을 쓰지 않음) |
| `… src/api/apiSession.test.ts` / `src/utils/offlineSessionStub.test.ts` | 220 passed + 작업 전부터 실패하던 1건 / 1 passed | 주문 05b |
| `… runCodex.capacityRetry` / `runCodex.channelClear` / `runCodex.lessonProposal` | 31 / 7 / 34 passed | 주문 04, 05, 05b |
| `… codexThreadFork` / `codexThreadTransfer` / `resumeExistingThread` / `codexEndInput` / `codexAbortNotice` | 4 / 9 / 2 / 10 / 6 passed | 주문 03 |

- 검수자 재실행(빌드 없는 설정): 주문 03 검수 9파일 337 passed, 주문 04 검수 9파일 466 passed.
- 빌드 없는 회귀: 주문 04에서 코덱스 매퍼·runCodex를 쓰는 테스트와 작업 전 기준 코덱스 묶음까지 28파일 통과.
  2026-10-28 문서 작성 때 spec의 테스트 이름을 대조하려고 5파일(클라이언트·재생·트래커·`runCodex.shutdown`·매퍼)을
  다시 돌려 387 passed.
- 녹음 재생 하네스(바뀐 런타임으로 실시간 1/4 축소 재생): 6개 녹음 모두 한 턴, 그 턴 안에 `CodexAgent` 줄 한 쌍,
  `turn-end` 뒤 envelope 0개, 목록 발행 `[]` → `[자식]` → `[]`. 목록 발행이 줄보다 먼저 나가 Desktop에서 줄이
  처음부터 "실행 중"으로 보인다. 서브 에이전트 흔적을 뺀 재생은 작업 전 출력과 같다(앞쪽 빈 목록 발행 1건 제외).
- 검증하지 않은 것:
  - unit 전체: 작업 전 기준선에서 이 환경은 15파일 55건이 원래 실패한다(Claude 런처 계열, 설치 스크립트 등. 이
    작업과 무관). 회귀는 코덱스 부분집합을 파일별로 돌려 판단했다.
  - 실제 Codex 세션과 Desktop 화면(주문 10).
  - Codex 0.105 미만 실기. 이 머신에는 0.157.1만 있어 버전 게이트 단위 테스트로 대신했다.
  - 공식 커버리지 수치(제공자 미설치). 트래커 분기 근사치만 99.2%.

## 열린 문제

1. **(기존, 범위 밖) 중단된 턴이 `completed`로 기록됨.** 메인 스레드도 `idle`이 `turn/completed`보다 먼저 와서 기존
   idle 폴백이 먼저 턴을 닫는다. 녹음 c 두 건은 실제로 `interrupted`인데 `turn-end/completed`가 된다. 이 작업은
   현상을 유지한다(재생 테스트도 "메인 자신의 첫 종료 신호 뒤 해소"로 고정).
2. **(기존) 녹음에서는 `rawResponse/completed`가 오지 않았다.** 런타임과 같은 설정(`experimentalRawEvents: false`)으로
   녹음한 6건에서 0건이었다. 그 설정이 켜졌을 때는 확인하지 못했다. 자식 것도 통과시키는 규칙(D11)은 그 알림이 오는
   경우를 위한 것이고 실측으로 확인하지 못했다.
3. **(남은 위험) 연결마다 `codex --version`을 한 번 더 실행한다.** 체크포인트 보호 세션은 턴마다 다시 연결하므로
   턴마다 한 번이다. 측정하지 않았다. `isAppServerAvailable()`이 읽은 버전을 재사용하는 구조 변경으로 줄일 수 있다
   (기존 줄 수정이라 이번 범위 밖).
4. **(남은 위험) 살아 있는 클라이언트에서 fork하면 새 스레드 알림 일부가 떼어 내질 수 있다.** 응답과 같은 청크로 온
   새 스레드 알림(`thread/tokenUsage/updated`, 이어받은 goal 스냅샷)은 `_threadId`가 아직 옛 메인이라 자식 것으로
   처리된다(`token_count`·`thread_goal_updated` 유실, fork id에 `thread/read` 한 번 추가). 지금 fork는 새
   클라이언트(`apiMachine.withCodexAppServerClient`, 메인이 없어 떼어 내지 않음)에서만 하므로 해당 없다. 살아 있는
   클라이언트에서 fork하는 호출부가 생기면 start/resume/fork 응답을 기다리는 동안의 예외가 필요하다.
5. **(남은 위험) 트래커 `thread/read` 중에는 인증 복구가 거절될 수 있다.** 분류 읽기나 5초 폴링이 진행 중인 순간에는
   `authRecoveryBusy`가 참이 된다. 서브 에이전트가 있는 세션에서만 생기고, 기존 background terminal 새로고침과 같은
   성질이다.
6. **60분 턴 종료 정리기 — 해소(주문 05b 채택, 2026-10-28).** 데몬 정리기는 깨끗한 턴 종료 뒤 60분 조용한 세션을
   SIGTERM한다(재개 가능). 면제 플래그 `launchedBackgroundJob`은 클로드의 `run_in_background: true` 도구 호출로만
   켜졌고 `CodexAgent` 줄(args `{ agent }`)로는 켜지지 않아, 메인 턴 뒤 60분 넘게 도는 코덱스 자식이 런타임과 함께
   끝나고 도구 줄이 "완료"로 남을 수 있었다. 이제 runCodex가 자식이 1개 이상 든 목록을 쓰기 직전에
   `session.markLaunchedBackgroundJob()`으로 같은 플래그를 켠다(spec R8). 플래그는 턴 종료 보고나 keep-alive 재보고(30초 안)로
   데몬에 가고, 데몬은 그 런타임이 살아 있는 동안 이 세션을 60분 정리에서 빼 24시간 절대 컷으로 미룬다(클로드
   백그라운드 launch와 같다). 빈 목록·`null` 목록은 켜지 않아 서브 에이전트 없는 세션은 그대로다. 데몬은 바꾸지
   않았다. 남은 한계: 오프라인으로 시작한 세션은 재연결 전 목록을 대체 객체가 버리므로(표시도 no-op, 목록
   메타데이터도 같다) 재연결 뒤 자식이 든 목록이 새로 나올 때 켜진다. 자세한 내용은
   [plan.md Phase 5b](./plan.md#phase-5b--60분-턴-종료-정리기-면제-주문-05b-선택--완료).
7. **워치독 — 해소(주문 05 채택, 2026-10-28).** 비활성 워치독(10분)은 메인 스레드 활동만 세서, 부모가 `wait_agent`로
   10분 넘게 자식만 기다리면 메인 턴이 중단됐다(이 작업 전부터 있던 동작). 이제 떼어 내기 게이트가 추적 중인
   스레드(손자 포함)의 `turn/started`·`item/*`·`thread/tokenUsage/updated`를 받으면 메인 턴의 비활성 타이머를 다시
   건다(spec R1). 계보 밖·미분류 스레드는 세지 않는다. 기다리는 메인 턴이 없거나 승인·입력 요청이 답을 기다리는
   동안에는 기존 규칙대로 아무것도 하지 않는다. 자식의 `rawResponse/completed`는 전처럼 세지 않는다(D11). 남은 한계:
   자식이 계속 보고하는 동안에는 메인 스레드가 실제로 멈췄어도 중단이 미뤄지고, 자식이 조용해진 때부터 10분 뒤에
   중단된다. 자세한 내용은 [plan.md Phase 5](./plan.md#phase-5--워치독-완화-주문-05-선택--완료).
8. **(알려진 제한) 일찍 온 final answer 뒤 다시 열린 수명주기에서는 spawn 줄이 없다.** 그때는 `sendTurnAndWait`가
   기다리는 턴이 없어 줄을 내지 않는다. 목록에는 보인다.
9. **(알려진 동작)** 부모 턴을 중단해도 자식은 끝날 때까지 목록에 남는다(P7). 같은 자식이 `followup_task`·
   `resume_agent`로 다시 돌면 "완료"였던 줄이 다시 "실행 중"이 된다(Codex에서도 다시 도는 중이다). 자식 스레드의
   승인·입력 요청은 지금처럼 메인 승인 경로로 뜨고, 자식 턴 id라 메신저 상관관계는 없다(spec 비목표).
10. **(알려진 제한)** 실패하거나 중단된 서브 에이전트도 줄에는 "완료"로 보인다. 목록에는 실행 중 여부만 있다.
    Codex는 `errored`·`systemError`·실패한 `turn/completed`로 결과를 알려 주지만, 이 기능은 실행 중/완료만 보인다.
    실패 표시가 필요하면 목록 항목에 결과를 더하고 Desktop 배지를 새로 만들어야 한다(새 기능, 2026-10-28 셀프 리뷰 3라운드 기록).
11. **(범위 밖, 기존 코드)** `supportsGoalActions()`(`codexAppServerClient.ts`)는 부를 때마다 `codex --version`을 실행한다.
    runCodex가 목표 이벤트마다 부른다. 이 작업 전부터 있던 동작이라 고치지 않았다. 연결 때 읽은 버전을 함께 쓰면 줄어든다
    (Fable 셀프 리뷰 검수 권고).
12. **(알려진 제한, 사용자 수용 2026-10-28)** 첫 `thread/read`가 실패한 자식은 줄 제목이 폴백 이름이고, 재시도로
    nickname을 받으면 맨 아래 줄 이름만 바뀐다(D16). 실앱에서 8번 중 2번 첫 읽기가 실패했다(둘 다 GPT-6 Luna).
13. **(Saycode 지침과의 관계)** Saycode가 넣는 자식 대화 지침 때문에 "서브 에이전트를 띄워 줘" 같은 요청은 내장
    서브 에이전트가 아니라 `happy agent spawn`(별도 Saycode 대화)으로 처리된다. 이 기능의 표시는 Codex가 한 턴 안에서
    스스로 `spawn_agent`를 쓸 때 나온다(실앱 2026-10-28 확인).

## 릴리스 체크리스트 (실행하지 않음)

[AGENTS.md](../../AGENTS.md)와 [docs/happy-cli-release.md](../../docs/happy-cli-release.md)를 따른다. 외부 행위마다
정확한 버전·대상 커밋·명령을 보이고 사용자의 **직전 승인**을 받은 뒤 메인 세션이 실행한다. 계획이나 구현 승인은 발행
승인이 아니고, 승인 뒤 행위 목록이 바뀌면 다시 묻는다.

- [x] 1. 기능 변경 커밋(사용자 승인 뒤). 구조 변경 `emitCodexUsage()` 추출(동작 동일)을 `[structural]`로 먼저, 나머지를
  `[behavioral]`로 나눈다.
- [ ] 2. push → PR(`gh pr create --repo buzzni/happy --base main …`) → CI 통과 → main 머지. push·PR 생성·머지는
  각각 사용자 승인 뒤에 한다. 이 브랜치는 `.362`(346fe458) 위에 있다. PR 전에 최신 main을 가져온다(2026-10-29
  `git merge-tree`로 `.364`(3bc47156)와 충돌 없음 확인).
- [ ] 3. 버전 bump(**사용자 승인 뒤 메인 세션이 커밋**): `packages/happy-cli/package.json`을 그때 main의 번호 →
  다음 빈 번호(2026-10-29 기준 `1.1.10-aplus.365`). 이 저장소 관례대로 bump만 담은 `[behavioral] release(cli): … 후보
  준비` 커밋·PR로 main에 머지한다. 런북 Version Bump 2단계대로 빌드와 관련 테스트를 돌린다. 직전에 그 번호가 비어
  있는지 다시 본다(2026-10-29 확인: 원격 태그 `.363`(10-28 16:54)·`.364`(10-28 23:01)는 이 기능 없이 다른 변경으로
  발행됐다). 그사이 main에 다른 변경이 들어왔으면 포함 범위를 커밋 본문에 적는다. 번호가 `.365`가 아니면 Desktop
  문구 6줄(`git grep -n "aplus\.365"`)도 같은 번호로 바꾼다.
- [ ] 4. 태그 push(**별도 직전 승인**): bump가 머지된 main 커밋에 태그 하나 — `git tag happy-cli-v1.1.10-aplus.365
  <main 커밋>` → `git push origin happy-cli-v1.1.10-aplus.365`. 워크플로 `Publish @buzzni/happy-cli`가 태그와
  `package.json` 버전이 같은지 확인한 뒤 빌드·guard·발행·검증한다.
- [ ] 5. 로컬 발행 금지: `npm publish`·`pnpm publish`·`yarn publish`를 어디서도 실행하지 않는다(준비 디렉터리와
  tarball 포함). 발행은 GitHub Actions만 한다. 실패한 발행 작업은 다시 돌리지 않는다.
- [ ] 6. 서버 선배포 불필요: usage wire(`packages/happy-wire/src/usage.ts`)를 비롯해 `packages/happy-wire`를 바꾸지
  않았다. `CodexAgent` 줄은 기존 wire 필드만 쓴다.
- [ ] 7. 레지스트리 확인: `latest`가 `1.1.10-aplus.365`, tarball URL 200, 새 prefix 설치 뒤 `happy daemon status` 성공
  (워크플로의 검증 단계). 전파가 늦어 실패하면 재발행하지 말고 검증 전용 실행
  (`gh workflow run publish-happy-cli.yml --repo buzzni/happy --ref main -f version=1.1.10-aplus.365`)을 쓴다. 이것도
  외부 행위라 승인 뒤에 한다.
- [ ] 8. Desktop 런타임 pin은 7이 끝난 뒤(주문 10). 발행되지 않은 버전으로 pin을 쓰지 않는다.
- [ ] 9. 런북 완료 기준의 나머지: `buzzni/aplus-dev-studio`의 `vendor/happy` 포인터를 머지된 main 커밋으로 올리는
  PR(런북 Completion Checklist 5·6). 담당은 메인 세션이다(주문 10의 릴리스 단계, 레지스트리 검증 뒤, 사용자 승인).
  wire를 바꾸지 않았으므로 태그 전에 해야 하는 전제는 아니다.

## 다음 시작점

리뷰 결과 반영 → 커밋·PR과 위 릴리스 체크리스트를 순서대로 진행한다. 주문 05·05b는 2026-10-28 채택·구현했다(열린
문제 6·7 해소).
