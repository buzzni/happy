# Claude 턴: 일시 장애 자동 복구

Date: 2026-10-18. Authorized: 사용자가 hermes 벤치마킹 계획 H9a를 승인(구현까지, 배포 제외).
분류: Core — 세션 턴 수명주기(입력 큐·턴 종료·세션 상태)를 소유하는 런타임 변경이라 Extension 경계 밖이다.
Desktop 표시(카운트다운·취소 버튼)는 H9b(별도 작업).

## 배경
hermes-agent `agent/turn_recovery_autorecover.py`(MIT, Nous Research): 제공자의 일반 재시도가 다 떨어진 뒤에도
장애가 일시적(5xx·529·타임아웃)이고 답이 한 글자도 나가지 않았으면, 지터를 더한 15·30·60·60·60초 간격으로
최대 5회 더 기다렸다 같은 턴을 다시 시도한다. 제공자의 Retry-After 는 120초까지 존중한다.
Saycode 의 Claude 턴은 Claude Code 자체 재시도(기본 10회, 수십 초~수 분)가 끝나면 "API Error: 503 …"으로
실패하고, 사용자가 직접 다시 보내야 한다. Codex 는 용량 오류만 5·20초 뒤 2회 자동으로 이어 간다
(`src/codex/codexCapacityRetry.ts`, happy #848·#853).

## 조사 (2026-10-18, SDK 0.3.285 번들 CLI 를 가짜 API 서버에 붙여 실측)
- Claude Code 는 재시도할 오류마다 `system/api_retry`(attempt·max_retries·retry_delay_ms·error_status·error)를
  내보낸다. `retry-after: 7` 헤더를 주면 `retry_delay_ms: 7000` — CLI 가 이미 Retry-After 를 따른다.
  연결 단절은 `error_status: null`, 짧은 지수 대기(0.6·1.2초).
- 재시도가 다 떨어지면 합성 assistant 메시지(`model: "<synthetic>"`, `is_api_error_message: true`,
  `error: "server_error"`, usage 전부 0) 뒤에 `result`(`subtype: "success"`, `is_error: true`,
  `terminal_reason: "api_error"`, `api_error_status`: 503/529/400 또는 연결 단절이면 null, usage·비용 0)가 온다.
  400 은 `api_retry` 없이 바로 같은 모양으로 끝난다.
- 사용자 프롬프트는 API 요청 전에 transcript 에 저장된다. 실패 뒤 같은 대화에 메시지를 하나 더 보내면
  CLI 는 합성 오류 메시지를 API 요청에서 빼고 두 user 메시지를 하나로 합쳐 보낸다(실측: 두 번째 요청의
  messages 가 `user: "hello there | NUDGE…"` 하나). 따라서 **원래 프롬프트를 다시 보내면 모델이 같은 요청을 두 번
  본다** — 재시도는 짧은 이어가기 안내문을 보낸다(D2).
- 재사용 판단: Codex 판정(`isCodexServerOverloadedFailure`)은 Codex `task_complete` 모양 전용이고, 정책은
  15줄 횟수 세기라 공통화 이득이 없다(AGENTS §1.5 "중복은 세 번째에"). 모양만 같은 별도 모듈로 둔다.

## 요구사항
- R1. 재시도 대상: 턴 결과가 `is_error` 이고 `terminal_reason` 이 `api_error`(구 CLI 처럼 없으면 상태 코드로만)이며
  `api_error_status` 가 408 또는 500~599(529 포함)인 경우, 또는 상태가 null(HTTP 응답 없음 = 연결 단절·타임아웃)이고
  `terminal_reason: api_error` 인 경우. 4xx(인증·잘못된 요청·429 한도), `result.api_error` 가 붙은 결정적 오류,
  인증·결제·클라우드 자격 오류 분류(`error`), 사용자 중단, 슬래시 명령 턴, 채널(메신저) 요청 턴, 관리 실행·
  run-once 자동화 턴은 제외한다.
- R2. 대기: 지터(+0~20%)를 더한 15·30·60·60·60초, 최대 5회. 실패한 시도의 마지막 `api_retry.retry_delay_ms` 가
  더 길면 그 값(상한 120초)을 쓴다(D3).
- R3. 답 텍스트·thinking·도구 호출·서브에이전트·도구 결과 중 하나라도 나온 턴은 재시도하지 않는다. 스트림 미리보기
  (`stream_event`)로 글자가 나간 경우도 포함한다.
- R4. 재시도 대기 상태를 `agentState.transientRetry` 로 노출한다: provider·attempt·maxAttempts·reason·status·
  scheduledAt·retryAt. 대기가 끝나거나 취소되면 null 로 지운다. 사람이 읽는 안내 한 줄을 세션 이벤트(`message`)로
  보낸다(구 Desktop 에도 보이도록). 구 Desktop 은 모르는 agentState 필드를 읽지 않는다(바쁨 표시는
  `controlledByUser`·`requests` 만 본다).
- R5. 사용자가 중단(abort RPC)하거나 새 메시지를 보내면 대기 중 재시도를 즉시 취소한다. 취소된 재시도는 나중에도
  보내지 않고, 사용자 메시지와 재시도가 한 번에 둘 다 나가지 않는다. 대기 중 제공자 프로세스가 스스로 끝나도
  재시도는 다음 제공자 세대에서 나간다(끝난 세대가 가져가 버리지 않는다). 대기 중 입력이 닫히면(standalone drain·
  관리 실행 종료) 재시도 없이 그대로 끝난다.
- R5a. **취소 계약(H9b).** 별도 RPC 없이 기존 `abort` RPC 가 취소 버튼이다. 재시도만 기다리고 제공자가 idle 이면
  (`session.thinking === false`) 대기만 지우고 끝난다 — 제공자 프로세스를 죽이지 않고(재기동·MCP 재연결 없음),
  `turn-end: cancelled`·"Aborted by user" 이벤트도 보내지 않는다(실패한 시도는 이미 `failed` 로 닫혔다).
  결과는 `agentState.transientRetry: null` 로만 드러난다. 대기 중 제공자가 스스로 턴을 돌리고 있으면(백그라운드
  작업 보고) 지금처럼 그 턴을 중단한다. `switch`·종료는 대기를 지우고 기존대로 제공자를 끝낸다.
- R6. 비용: 실패한 시도는 합성 메시지·result 모두 usage 0 이라 집계에 더해지지 않고, 재시도 턴은 자기 usage 만
  한 번 집계된다(기존 assistant usage·result 보정 경로 그대로).

## 결정
- D1. **턴 종료 뒤 이어가기(Codex 방식).** 실패한 시도는 기존대로 `turn-end: failed` 로 닫고, 다음 입력 대기
  (`nextMessage`) 자리에서 타이머와 사용자 입력을 경주시킨다. 타이머가 이기면 같은 mode 로 이어가기 턴을
  돌려준다 — 같은 Claude 프로세스·같은 대화, 재시작 없음. 대안(턴을 연 채 `claudeRemote` 안에서 기다림)은
  결과 처리(체크포인트 적용·교훈 리뷰·MCP 복구)를 건너뛰는 분기를 새로 만들고, 그동안 도착한 큐 메시지를
  감지할 통로가 없어 R5 를 지킬 수 없다. 대기 중에는 "완료" 푸시 알림을 보내지 않는다(아직 끝나지 않았다).
- D2. **원래 프롬프트가 아니라 이어가기 안내문을 보낸다.** 위 조사대로 원래 프롬프트는 이미 transcript 에 있고,
  다시 보내면 중복된다. 안내문은 CLI 가 원래 메시지 뒤에 합쳐 보낸다.
  안내문은 교훈 회수 블록·교훈 리뷰 지시문 없이 그대로 보낸다(슬래시 명령과 같은 우회). CLI 가 원래 메시지와
  합치므로 원래 메시지에 붙은 블록·지시문이 이미 그 안에 있고, 다시 붙이면 재시도마다 중복이 transcript 에 남는다.
  비용: 재시도 한 번에 안내문 한 줄(약 30토큰)과 원래 요청 전체의 재전송 입력 토큰이 든다 — 후자는 어떤 재시도
  방식이든 피할 수 없다.
- D3. **Retry-After 근사.** SDK 는 원 헤더를 넘겨주지 않는다. CLI 의 `retry_delay_ms` 는 헤더가 있으면 그 값,
  없으면 짧은 지수 대기다. 그래서 일정보다 길 때만 따른다(max(일정, min(힌트, 120초))) — 헤더 없는 짧은
  대기가 일정을 줄이지 않게 한다. hermes(헤더가 일정을 대체)와 다른 점이다.
- D4. **예산은 사용자 요청 단위.** 사용자 메시지(또는 보류됐던 배치)가 턴으로 나가거나, 재시도 대상이 아닌
  결과로 턴이 끝나면 0 으로 돌린다. 5회를 다 쓰면 안내 한 줄을 남기고 멈춘다.
- D5. **CLI 재시도와 겹치지 않는다.** `api_retry` 는 관찰만 하고(힌트), 재시도는 CLI 가 포기한 최종 결과에서만
  시작한다. 각 이어가기 턴은 다시 CLI 자체 재시도를 거친다(hermes 도 같다).
- D6. **관리 실행·run-once 제외.** 관리 실행은 승인된 프롬프트 하나만 답한다(이어가기 안내문은 승인 밖 입력).
  run-once 자동화는 첫 결과에서 프로세스를 끝내는 구조라 이번 범위에서 제외 — 후속 후보(context.md).
- D7. **agentState 잔존.** CLI 가 대기 중 죽으면 `transientRetry` 가 남을 수 있다. 런처가 끝날 때 지우고,
  H9b 는 `retryAt` 이 지난 상태를 낡은 것으로 다룬다.

## 호환성
- 구 Desktop: `agentState.transientRetry` 를 무시한다. 안내 문구는 일반 이벤트 메시지로 보인다.
  실패한 시도는 지금처럼 오류 문구와 실패 턴으로 보이고, 잠시 뒤 새 턴이 자동으로 시작된다.
- Desktop 변경 없음(H9b). 서버 변경 없음.

## 범위 밖
Desktop 카운트다운·취소 UI(H9b), 429/한도 소진(H9b), Codex 재시도 변경, run-once·관리 실행 재시도,
배포(태그·발행·pin).
