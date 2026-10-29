# Codex 서브 에이전트 활동 — 런타임 Plan

> 작성일: 2026-10-28 / 상태: Phase 1~5·5b 완료(미커밋), Phase 6 문서 완료·릴리스 승인 대기 /
> 근거: [spec.md](./spec.md), 기록: [context.md](./context.md)

Phase 번호 옆의 "주문 NN"은 이 작업을 나눈 내부 작업 지시 번호다.

## 승인

2026-10-28 사용자가 코덱스 서브 에이전트 표시를 런타임 수정까지 포함해 승인했다. 범위는 "진행 중만 보이기"이고,
끝남은 클로드와 같은 방식(대화 속 줄이 실행 중 → 완료, 대화 맨 아래 줄, 사이드바·탭)으로 보인다. 조건은 넷이다:
비정상으로 보이지 않을 것, 코덱스처럼 서브 에이전트가 돌고 끝나는 걸 알 수 있을 것, 기존 기능에 영향이 없을 것,
구 Desktop·구 런타임·구 Codex 조합이 계속 동작할 것.
이 승인은 커밋·push·PR, 버전 bump, 태그 push, 발행을 포함하지 않는다. 각각 직전에 따로 승인받는다
([context.md 릴리스 체크리스트](./context.md#릴리스-체크리스트-실행하지-않음)).

## 파일 배치 (수정 11 / 신규 21)

- 신규 `packages/happy-cli/src/codex/codexSubagentTracker.ts` — 자식 스레드 추적(분류·상태·목록·이름)은 하나의
  책임이고 app-server 프로세스 없이 단위 테스트할 수 있어, 3,000줄이 넘는 클라이언트 밖의 순수 클래스로 둔다
  (`codexBackgroundTasks.ts`와 같은 방식).
- 신규 `codexSubagentTracker.test.ts`, `codexSubagentReplay.test.ts`, `testing/replayCodexRecording.ts`(녹음 재생용
  가짜 app-server 프로세스. 같은 일을 하는 유틸이 저장소에 없었다), `__fixtures__/subagent-recordings/`(README 1,
  녹음 6, golden 6).
- 신규 `specs/codex-subagent-activity/` 문서 3개.
- 수정 `codexAppServerClient.ts`·`.test.ts`, `utils/sessionProtocolMapper.ts`·`__tests__/sessionProtocolMapper.test.ts`,
  `runCodex.ts`·`runCodex.shutdown.test.ts`, `src/api/types.ts`, `docs/session-protocol.md`(한 단락).
- 수정 `src/api/apiSession.ts`·`apiSession.test.ts`(주문 05b, 공개 메서드 하나와 테스트 2건), `src/utils/offlineSessionStub.ts`
  (같은 이름의 no-op 한 줄). 신규 `src/utils/offlineSessionStub.test.ts`(대체 객체 전용 테스트가 없었다, 1건).
- 바꾸지 않은 것: `packages/happy-wire`(wire 스키마·usage 스키마), 데몬, 다른 에이전트 경로.

## Phase 1 — 녹음 fixture·재생 유틸·identity golden (주문 01) ✅ 완료

1. 실제 Codex app-server 0.157.1 녹음 6개를 개인정보를 지운 fixture로 넣는다. 녹음에서 서브 에이전트 흔적을 뺀
   스트림을 작업 전 런타임(`1.1.10-aplus.360`)에 통과시킨 출력을 golden 6개로 둔다.
2. 재생 유틸: 가짜 프로세스가 녹음된 `thread/read`·`thread/loaded/list` 응답을 녹음 순서와 지연대로 돌려주고 알림을
   순서대로 흘린다. 가짜 타이머로 매번 같은 결과가 나온다.
3. `codexSubagentReplay.test.ts`: identity(바꾸기 전 코드에서도 통과해야 함)와 full stream 목표 테스트.

검증: 변경 전 코드에서 identity 6/6 통과, full stream 24건은 기대한 결함(P1~P4, 기능 없음)으로 실패(RED).
fixture에 실제 홈 경로(`/Users/REDACTED`로 치환)·이메일·토큰·호스트명·`installationId`가 없음을 grep으로 확인했다.

## Phase 2 — `CodexSubagentTracker` (주문 02) ✅ 완료

1. 의존성·타이머를 주입받는 순수 클래스: `thread/read` 분류(재시도 1회, spawn 증거로 승격), 실행 상태표, 표시 목록
   (상한 50), 이름 규칙, 첫 발행 지연(규칙 B), 5초 정합 폴링, 무효화, 어떤 경로에서도 throw 없음.
2. 13개 묶음 + 상태표 29 + 목록 3 = 테스트 98건. 묶음마다 RED를 확인한 뒤 구현했다.

검증: 98 passed(공식 명령), `tsc --noEmit` 오류 0. 분기 커버리지는 공식 제공자가 없어 근사치 99.2%.

## Phase 3 — 클라이언트 떼어 내기·가로채기·spawn 이벤트 (주문 03) ✅ 완료

1. 구조 변경 먼저: `rawResponse/completed` 처리 본문을 `emitCodexUsage()`로 추출(동작 동일, +20/−15).
2. 동작 변경: `handleNotification` 게이트(`serverRequest/resolved` 다음), 부모 쪽 항목 가로채기
   (`reopenConsumerLifecycleOnResumedWork` 앞), `collab_agent_spawned` 이벤트(이름 1.5초 대기 뒤 턴·프로세스 재확인),
   비우는 지점(`finishExit`, `performDisconnectInternal`, 강제 재시작, `clearThreadState`), 연결 때 버전 게이트,
   `pointSubagentsAtMainThread()`(메인 id나 app-server 프로세스가 바뀔 때만 목록 새로 시작).
3. 재생 테스트에서 `subagent_tasks`를 golden 비교와 떼어 따로 단언한다.

검증: 새 테스트 26건(구현 전 24건 RED), 클라이언트 187 passed, identity 6/6, 회귀 묶음 9파일 337 passed, 넣은 줄마다
변이 12건이 모두 테스트에 걸렸다. 메인 경로의 기존 줄은 바뀌지 않았다(삭제 15줄은 추출분).

## Phase 4 — 매퍼·runCodex·메타데이터 타입 (주문 04) ✅ 완료

1. 매퍼 `collab_agent_spawned` 분기(`token_count` 다음, `resolveSessionSubagent` 앞), runCodex `subagent_tasks` →
   `metadata.codexSubagentTasks`(`background_tasks` 바로 다음, try/catch), `Metadata.codexSubagentTasks` 타입.
2. 재생 테스트의 환경변수 게이트를 풀어 36건을 항상 돌린다.

검증: 새 테스트 12건(매퍼 7, runCodex 5, RED 확인), 공식 명령 7파일 통과(매퍼 23, `runCodex.shutdown` 43, 재생 36,
클라이언트 187, `runCodex.capacityRetry` 31, `runCodex.channelClear` 7, `runCodex.lessonProposal` 34)와 tsc 오류 0,
빌드 없는 회귀 28파일 통과. 줄 envelope는 strict wire 스키마로 parse했고, 새 가드마다 변이 6건이 걸렸다.

## Phase 5 — 워치독 완화 (주문 05, 선택) ✅ 완료

2026-10-28 사용자가 채택했다. 조건: 비정상으로 보이지 않을 것, 코덱스처럼 서브 에이전트가 돌고 끝나는 걸 알 수 있을
것, 서브 에이전트 없는 세션은 변화가 없을 것.

1. 떼어 내기 게이트의 `observeOtherThread` 직후에, 추적 중인 스레드(계보가 메인에 닿는 자식·손자)의 `turn/started`·
   `item/*`·`thread/tokenUsage/updated`가 오면 `schedulePendingTurnInactivityTimeout()`으로 메인 턴의 비활성 타이머를
   다시 건다(삽입 6줄). 이 함수는 기다리는 메인 턴이 없거나 승인·입력 요청이 답을 기다리면 아무것도 하지 않으므로
   두 기존 규칙은 그대로다. 메인 스레드 활동을 세는 `recordPendingTurnActivity`는 바꾸지 않았다.
2. 트래커의 `isTracked`를 공개했다(1줄). 계보 밖 스레드와 미분류 스레드(`thread/read` 응답 대기 중이거나 두 번
   실패했고 spawn 항목도 가리키지 않은 것)는 세지 않는다. 자식의 `turn/completed`·`thread/status/changed`·
   `rawResponse/completed`도 세지 않는다.

- 이유: 비활성 워치독(10분)은 메인 스레드 활동만 셌다. 부모가 `wait_agent`로 10분 넘게 자식만 기다리면 메인 턴이
  중단됐다(이 작업 전부터 있던 동작).

검증: 새 테스트 6건(클라이언트 `[15]`: 자식 보고가 900ms마다 오면 `turnTimeoutMs: 1000`에도 안 끊김 / 계보 밖·
`thread/read` 두 번 실패·응답 대기 중인 스레드의 보고는 세지 않음 3 / 자식이 조용해지면 마지막 보고 1000ms 뒤 중단 /
승인 대기 중에는 자식 보고가 워치독을 켜지 않음). 구현 전 2건이 실패했다(나머지 4건은 처음부터 통과하는 지킴 테스트).
격리 사본에 넣은 변이 3건(삽입 제거, `isTracked` 조건 제거, 승인 규칙을 건너뛰는 직접 재설정)이 모두 걸렸다. 공식
명령: 클라이언트 193, 재생 36, 트래커 98, `runCodex.shutdown` 46(05b 검수 수정 전 수치, 그 뒤 47), `runCodex.capacityRetry` 31,
`runCodex.channelClear` 7, `runCodex.lessonProposal` 34 passed, tsc 오류 0.

## Phase 5b — 60분 턴 종료 정리기 면제 (주문 05b, 선택) ✅ 완료

2026-10-28 사용자가 채택했다. 조건: 비정상으로 보이지 않을 것, 코덱스처럼 서브 에이전트가 돌고 끝나는 걸 알 수 있을
것, 서브 에이전트 없는 세션은 변화가 없을 것.

1. 공개 메서드 `ApiSessionClient.markLaunchedBackgroundJob()`이 클로드 `run_in_background` 도구 호출과 같은 private
   플래그 `launchedBackgroundJob`을 켠다. runCodex의 `subagent_tasks` 처리가 메타데이터 쓰기 직전(같은 try 안),
   자식이 1개 이상 든 목록일 때만 부른다. 쓰기가 실패해도 표시는 남는다. 빈 목록·`null` 목록은 부르지 않는다.
   오프라인 대체 객체(`utils/offlineSessionStub.ts`)에는 같은 이름의 no-op을 두어 일반 호출로 부른다(대체 객체는
   `as unknown as ApiSessionClient`라 메서드가 빠져도 tsc가 잡지 못하므로 테스트 1건으로 고정).
2. 플래그는 턴 종료 보고에 실리고, 턴 종료 뒤에 켜졌으면 keep-alive가 같은 보고를 다시 보내는 30초 안에 실린다.
   데몬은 sticky로 병합해(`daemon/run.ts`) 그 런타임이 살아 있는 동안 이 세션을 60분 턴 종료 정리에서 빼고 24시간
   절대 컷으로 미룬다(클로드 백그라운드 launch와 같은 수명). 데몬과 클로드 경로는 바꾸지 않았다.

- 이유: 데몬 정리기는 턴 종료 뒤 60분 조용한 세션을 SIGTERM한다(재개 가능). 면제는 `launchedBackgroundJob`뿐인데,
  이 값은 `run_in_background: true` 도구 호출(클로드 백그라운드 launch)로만 켜졌다. 그래서 메인 턴 뒤 60분 넘게 도는
  코덱스 자식은 런타임과 함께 끝나고 도구 줄이 "완료"로 남을 수 있었다.
- 기각한 대안: `CodexAgent` args에 `run_in_background: true`를 넣기(Desktop의 메시지 기반 '백그라운드 작업 중'
  판정에 걸려 완료 알림·자동화가 바뀜), 정리기 자체 수정(모든 에이전트가 쓰는 경로라 범위가 넓음).

검증: 새 테스트 7건(`apiSession` 2: 턴 종료 보고에 실림, 턴 종료 뒤에 켠 표시는 30초 재보고에 실림 /
`runCodex.shutdown` 4: 자식 든 목록 → 1회, 메타데이터 쓰기가 실패해도 1회, 빈 목록·`null` 목록 → 0회 /
`offlineSessionStub` 1: 대체 객체의 표시는 no-op). 구현 전 3건, 검수 수정 전 2건(쓰기 실패·대체 객체)이 실패했다
(음성 2건은 처음부터 통과하는 지킴 테스트). 변이 3건(무조건 호출, `tasks !== null` 조건, 빈 메서드)이 모두 걸렸다.
공식 명령(검수 수정 뒤): `runCodex.shutdown` 47, `offlineSessionStub` 1, 재생 36, `runCodex.capacityRetry` 31,
`runCodex.channelClear` 7, `runCodex.lessonProposal` 34 passed, `apiSession` 220 passed와 작업 전부터 실패하던 1건
(조직 로그인 관찰 테스트, 이 작업과 무관), tsc 오류 0.

## Phase 6 — 문서·릴리스 준비 (주문 06) ✅ 문서 완료 / 외부 행위 미실행

1. spec·plan·context 작성, `docs/session-protocol.md` Subagents 절에 Codex 단락 하나.
2. 릴리스 절차는 [context.md](./context.md#릴리스-체크리스트-실행하지-않음)에 체크리스트로만 둔다. 버전 bump,
   태그, 발행은 하지 않았다.

검증: 문서의 상대 링크가 모두 실제 파일·제목을 가리키는지 확인했다. spec의 테스트 이름 173건을 실제 실행 결과
(빌드 없는 설정으로 5파일 387 passed)와 대조했고, `tsc --noEmit` 오류 0이다.

## 이후

1. 리뷰 → 결과 반영(주문 05·05b는 2026-10-28 채택·구현).
2. 사용자 승인 뒤 커밋(구조 변경과 동작 변경을 나눔)·PR(`buzzni/happy`) → main 머지.
3. 다음 빈 번호 릴리스(번호는 bump 직전에 원격 태그로 확인 — 2026-10-29 기준 `.363`~`.366`은 다른 변경으로 발행됨, context.md 체크리스트, 단계마다 직전 승인). `buzzni/aplus-dev-studio`의 `vendor/happy` 포인터 PR은
   메인 세션이 맡는다(주문 10의 릴리스 단계, 레지스트리 검증 뒤, 사용자 승인). wire를 바꾸지 않았으므로 태그 전에
   해야 하는 전제는 아니다.
4. Desktop(`aplus-dev-studio-desktop`, 주문 07~09) → 실앱 검증과 Desktop 런타임 pin(주문 10, 레지스트리 검증 뒤).

런타임과 Desktop은 어느 쪽을 먼저 내보내도 안전하다(spec 호환성).

## 되돌리기

- 동작 커밋을 revert한다. 구 Desktop은 이 키를 읽지 않고, 새 Desktop은 키가 없으면 지금과 같다.
- 주의: 되돌린 런타임은 `codexSubagentTasks`를 더 쓰지 않는다. 그 전에 새 런타임이 비우지 못하고 죽은 세션이면
  남은 목록을 지울 주체가 없다. 새 Desktop이 깔린 상태에서 런타임만 되돌리면 Desktop의 키 읽기 변경도 함께
  되돌린다.
