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
- R2. 간격 5·15·30분(각 실패 시점 기준), 최대 3회. 재시도 시각이 다음 정규 실행과 같거나 늦으면 재시도하지 않고
  정규 실행에 맡긴다. 같은 회차가 두 번 실행되지 않는다.
- R3. 재시도가 남은 동안 실패를 보고하지 않는다. 마지막까지 실패하면 기존 실패 보고 경로로 한 번만 기록한다.
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
- D5. **재시도 표시는 기존 필드로.** 같은 run 행의 startedAt(원래 시각)과 completedAt(재시도 시각) 차이로
  재시도였음이 드러난다. degradedCode 는 web-ui 가 "제한 실행"으로 표시하므로 쓰지 않는다. 최종 실패의
  failureCode 는 마지막 시도의 원래 코드(예: GRANT_EXCHANGE_FAILED)를 유지한다. 데몬 로그에 시도 n/3 을 남긴다.
- D6. 재시도로 세션을 띄워도 정규 주기는 재시도 시각 기준으로 밀지 않는다(lastSessionId 만 기록).
- D7. 정규 실행·즉시 실행 요청이 due 가 되면 보류 run 을 먼저 실패로 마감·전송한 뒤 claim 한다(서버 active-run 해소).

## 호환성
- 구 데몬: `unreachableRetries`를 모르는 파서는 필드를 버린다(보류 중이던 run 은 ABANDONED 로 남을 뿐, 파일은 유효).
- 서버·Desktop·web-ui 변경 없음. 보류 중인 run 은 서버에서 RUNNING 으로 보인다(최대 약 50분).

## 범위 밖
배포(태그·발행·pin), 서버 변경, claim/start 단계 재시도(D3·D4), 커넥터 preflight 실패 재시도
(CONNECTOR_RUNTIME_UNAVAILABLE 등은 연결성인지 설정 문제인지 이 계층에서 구분할 수 없다).
