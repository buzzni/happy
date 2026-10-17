# 예약 실행: 모델 호출 전 연결 실패 재시도

Date: 2026-10-17. Authorized: 사용자가 hermes 벤치마킹 계획 H2를 승인(구현까지, 배포 제외).
분류: Core — 예약 실행기(데몬)의 실행 수명주기·서버 run 보고 일관성을 소유하는 변경이라 Extension 경계 밖이다.

## 배경
hermes-agent `cron/unreachable_retry.py`(MIT, Nous Research): 예약 실행이 모델을 한 번도 부르기 전에
네트워크로 실패하면 5·15·30분 뒤 다시 실행하고, 재시도가 남은 동안 실패 알림을 보류한다.
Saycode 데몬(`serverAutomationExecutor.ts`)은 claim 직후 다음 시각을 넘기므로, 시작된 run 이
프롬프트 전달 전에 연결 실패로 끝나면 그 회차는 실패로 기록되고 다음 정규 시각까지 아무것도 하지 않는다.

## 요구사항
- R1. 실패를 "프롬프트를 세션에 전달하기 전/후"로 나눈다. 재시도는 전 단계의 연결성 실패만:
  MCP 호출 권한 교환·대화 대상 확인 요청이 상대에 닿지 못한 경우(ENOTFOUND, EAI_AGAIN, ECONNREFUSED,
  ETIMEDOUT, ECONNRESET 등 `serverConnectionErrors`의 연결성 코드, undici 연결 코드, 호출부 시간 제한,
  게이트웨이 502·503·504). 분류는 실제 소켓 테스트로 고정한다.
- R2. 첫 실패 기준 누적 약 1·2·4분(각 실패에서 1·1·2분), 최대 3회. 모든 재시도는 서버 run lease 안에서 끝난다:
  재시도 시각은 서버가 준 lease 만료 시각(start·heartbeat 응답의 `runLeaseExpiresAt`)에서 90초를 뺀 시각을 넘지 않고,
  그 안에 넣을 수 없으면 재시도하지 않는다. 재시도 시각이 다음 정규 실행과 같거나 늦으면 재시도하지 않고
  정규 실행에 맡긴다. 같은 회차가 두 번 실행되지 않는다.
  **사용자 결정으로 축소(2026-10-17)**: 원 요구(hermes 와 같은 5·15·30분)는 lease 5분을 넘는 단절에서 서버가
  `run-not-running` 으로 거절해 성립하지 않는다(교차 리뷰 #1). 서버 계약은 바꾸지 않고 재시도를 lease 안으로 줄였다.
- R3. 재시도가 남은 동안 실패를 보고하지 않는다. 마지막까지 실패하면 기존 실패 보고 경로로 한 번만 기록한다.
  실패 이력에 재시도 횟수가 남는다(D5). 보류 run 의 실패를 서버가 받기 전에는 같은 자동화의 정규 회차를 넘기지 않는다(D8).
  이미 취소된 run 의 보고처럼 서버가 영구히 거절하는 보고는 로그를 남기고 큐에서 지워 뒤 보고를 막지 않는다(D9).
- R4. 데몬이 재시작되면 이전 프로세스가 붙잡던 재시도는 이어 가지 않고, 보류한 실패를 기록한 뒤 로그를 남긴다.
- R5. 프롬프트 전달 뒤 실패(spawn·대화 전달 실패 포함), 사용자가 멈춘(일시정지·편집) 실행, 게이트로 건너뛴 실행,
  스크립트 조건 자동화, GitHub 트리거는 재시도하지 않는다.

## 결정
- D1. **같은 서버 run 을 붙잡는다.** 실패 보고 대신 run 을 RUNNING 으로 두고(틱마다 heartbeat) 같은
  runId·claimToken 으로 사전 단계부터 다시 실행한다. 근거: 서버는 claim 시각이 now±90초 밖이면 거절하고,
  FAILED 보고는 곧 실패 이력이며 Desktop 은 최근 3회 실패로 예약을 자동 일시정지한다. 재시도마다 새 run 을
  만들면 중간 실패를 숨길 정직한 outcome 이 없다(SKIPPED_GATE 는 "조건 미충족"이라는 거짓). 서버 변경 없음.
- D2. **재시작 시 보류 실패를 기록한다(R4의 "로그로 남긴다"보다 한 단계 더).** 보류 run 은 런타임 저장소
  `unreachableRetries`에 실패 보고와 함께 저장하고, 프로세스 표식(ownerId)이 다르면 재시작으로 보고
  그 보고를 pendingReports 로 넘긴다. 저장하지 않으면 run 이 영원히 RUNNING→ABANDONED("확인 불가")로 남아
  R3의 "한 번만 기록"을 지키지 못한다. 재시도 자체를 이어 가는 영속 큐는 아니다.
- D3. **claim 단계 연결 실패는 범위 밖.** 서버에 닿지 못한 채 지나간 회차를 나중에 실행하는 것은
  Desktop `specs/chat-scheduled-tasks` R9("연결 끊김 중 놓친 회차 소급 실행 없음")와 충돌한다. 기존 동작
  (due 유지 → claim 창 90초 경과 시 claim-denied 로 다음 회차) 그대로다.
- D4. **start 단계 연결 실패도 범위 밖.** claim token 은 2분에 만료되어 5분 뒤 재사용할 수 없고, 새 claim 은
  원래 run 이 "놓친 예약"(R10)으로 남는 별도 이력 설계가 필요하다. 후속 후보로 context.md 에 남긴다.
- D5. **재시도 표시는 기존 failureCode 로(교차 리뷰 #4 반영).** 재시도를 한 번이라도 거친 실패는
  `<원래 코드>_AFTER_<n>_RETRIES`(예: `GRANT_EXCHANGE_FAILED_AFTER_3_RETRIES`)로 기록한다. 서버 규칙
  `^[A-Z][A-Z0-9_]{0,63}$` 안이고, web-ui 는 failureCode 를 "사전 조건 실패: {code}"로 그대로 보이며 코드별 분기가
  없다(Desktop 은 서버 예약 run 의 failureCode 를 표시하지 않음). 규칙을 넘으면 원래 코드를 둔다.
  재시도 끝에 **성공한** run 은 기존 필드로 표시할 수 없다: 서버는 성공 보고의 failureCode 를 거절하고,
  degradedCode 는 web-ui 가 "제한 실행"으로 보이며, detailCiphertext 는 E2EE 암호문 자리다. 서버 스키마를
  바꾸지 않는 범위에서는 같은 run 행의 startedAt(원래 시각)과 completedAt(재시도 뒤 시각)의 차이와 데몬 로그
  (`unreachable retry n/3`)로만 남는다 — 후속 후보로 context.md 에 둔다.
- D6. 재시도로 세션을 띄워도 정규 주기는 재시도 시각 기준으로 밀지 않는다(lastSessionId 만 기록).
- D7. 정규 실행·즉시 실행 요청이 due 가 되면 보류 run 을 먼저 실패로 마감·전송한 뒤 claim 한다(서버 active-run 해소).
- D8. **마감 확인 전에는 claim 하지 않는다(교차 리뷰 #3).** 포기한 보류 run 은 `releasing` 으로 표시한 채
  `unreachableRetries` 에 남고, 서버가 보고를 받거나 영구 거절할 때만 지운다. 그 사이 같은 자동화는 due 를
  유지한 채 claim 을 건너뛴다 — 보고가 일시 실패한 채 claim 하면 서버가 active-run 을 돌려주고 실행기가 그 회차를
  넘겨 버린다. 보고가 claim 창(90초)보다 오래 막히면 그 회차는 D3 과 같은 규칙(서버 불통 중 놓친 회차)으로 지나간다.
- D9. **영구 거절 보고 정리(교차 리뷰 #2).** `run-not-running`(취소·만료·다른 보고로 끝남)과 `claim-not-found` 는
  다시 보내도 받아 줄 수 없으므로 로그를 남기고 큐에서 지운다. `report-conflict`(세션 동기화 전일 수 있음)와
  `invalid-input`(서버 내부 오류도 이 코드로 덮인다)은 일시 실패로 두어 기존처럼 다시 보낸다. 일반 미전송 보고
  큐(pendingReports)에도 같은 분류를 적용한다.
- D10. **lease 값은 서버 응답에서 읽는다.** start·heartbeat 응답의 `runLeaseExpiresAt` 을 저장하고, 보류 중
  heartbeat 가 성공할 때마다 갱신한다. 응답에 만료 시각이 없으면(구 서버) 재시도하지 않는다. 여유 90초 =
  데몬 틱 간격(기본 60초) + 사전 단계 요청(권한 교환 시간 제한 3초)·시계 차이 30초. lease 가 5분이고 heartbeat 도
  실패하면 재시도는 1·2·3.5분, heartbeat 가 lease 를 이으면 1·2·4분이다. lease 가 지나도록 틱이 돌지 못했으면
  (잠자기 등) 재시도 없이 실패를 기록한다.

## 호환성
- 구 데몬: `unreachableRetries`를 모르는 파서는 필드를 버린다(보류 중이던 run 은 ABANDONED 로 남을 뿐, 파일은 유효).
- 서버·Desktop·web-ui 변경 없음. 보류 중인 run 은 서버에서 RUNNING 으로 보인다(최대 lease 안, 약 4분).
- 구 데몬이 이 기능의 저장소 파일을 읽으면 `unreachableRetries` 를 버린다(보류 run 은 ABANDONED 로 남을 뿐).

## 범위 밖
배포(태그·발행·pin), 서버 변경, claim/start 단계 재시도(D3·D4), 커넥터 preflight 실패 재시도
(CONNECTOR_RUNTIME_UNAVAILABLE 등은 연결성인지 설정 문제인지 이 계층에서 구분할 수 없다).
