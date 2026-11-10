# 정원 보고 실패가 대화를 계속 막지 않게 하기

> 관련: aplus `specs/claude-setup-token-account-selection` (2026-11-08 계정별 활성 사용자 최대 4명). 이 문서는 happy-cli의 일시 실패 처리만 적는다.

## 문제

기존 대화에서 매 입력이 "조직 AI 계정의 사용 권한이나 실행 상태를 확인하지 못해 실행을 멈췄습니다…"로 실패한다는
보고(2026-11-10). 데몬 재시작처럼 잠깐 정원 보고가 실패한 뒤로 그 프로세스의 모든 턴이 실패했다. 실패가 두 층에서
굳었다.

1. `setupTokenUserCapacity.ts`의 실행별 보고(`report`)는 앞선 보고 promise 뒤에 이어 붙는다. 앞선 보고가 실패하면
   체인이 rejected로 남아, 이후 heartbeat·delivery·finish가 데몬에 닿지도 않고 같은 오류로 즉시 실패했다.
   그 실행은 끝을 보고하지 못해 자리가 풀리지 않았고, 15초마다 heartbeat가 같은 오류를 다시 냈다.
2. `claudeRemoteLauncher.ts`는 백그라운드 정원 작업(heartbeat·idle·result)의 실패를 `capacityFailure`에 담고
   지우지 않았다. 모든 다음 턴의 시작 허가가 그 값을 던져 실패했다(`aplus.401`부터).

## 요구사항

- R1. 한 실행의 보고는 순서대로 보내되, 앞선 보고의 성패와 무관하게 다음 보고를 보낸다.
- R2. 백그라운드 정원 작업의 실패는 경고 로그로 남기고 다음 턴을 막지 않는다. 다음 턴의 시작 허가는 앞선 백그라운드
  작업이 끝난 뒤 서버에 다시 묻는다. 4명 상한의 집행은 서버의 reserve/claim이 맡으므로 로컬에 남긴 실패로 막아
  얻는 안전은 없다(heartbeat 단절은 서버에서 unknown 자리로 계속 집계된다).
- R3. 서버가 그때도 응답하지 못하면 그 턴만 기존 문구로 실패한다.

## 비목표

- 저널 쓰기(`save`) 체인의 같은 형태 — 디스크 쓰기 실패는 이번 장애와 무관해 손대지 않았다.
- 실패한 heartbeat의 즉시 재전송 — 다음 주기(15초)의 heartbeat가 보낸다.

## 검증

- `npx vitest run --project unit src/claude/setupTokenUserCapacity.test.ts src/claude/claudeRemoteLauncher.setupTokenSwitch.test.ts`
- 두 새 테스트 모두 수정 전 실패를 확인했다: heartbeat 한 번 실패 뒤 다음 heartbeat가 같은 오류로 실패, 결과 보고 한 번
  실패 뒤 다음 턴이 시작되지 않음.
