# runtime-activity-heartbeat

## 배경

A+ Dev Studio의 자동 CLI 업데이트는 사용 중인 daemon을 교체하면 안 된다. 기존
daemon heartbeat에는 프로세스 생존 여부만 있고 실제 child session, daemon terminal,
automation 실행 여부는 없어서, scheduler와 daemon handoff가 busy 상태를 판단할
공통 계약이 필요하다.

## 요구사항

- R1. daemon은 살아 있는 tracked child session과 열린 daemon terminal session의
  합계를 `activity.activeSessionCount`로 보고한다.
- R2. legacy automation tick, server automation tick, active server automation lease의
  합계를 `activity.activeAutomationCount`로 보고한다.
- R3. activity에는 측정 시각 `reportedAt`을 포함하고, 기존 암호화된 daemon state
  update 경로로 전송한다.
- R4. activity count는 0 이상의 정수이며, 구버전 daemon과의 호환을 위해
  `activity` 필드 자체는 optional이다.
- R5. 교체된 bundle로 handoff할 때 session 또는 automation activity가 있으면 현재
  daemon을 유지한다.
- R6. replacement preflight가 진행되는 사이 activity가 새로 시작될 수 있으므로,
  teardown 직전에 activity를 다시 확인하고 busy이면 handoff를 유예한다.

## 수용 기준

- 암호화된 daemon heartbeat가 두 activity count와 `reportedAt`을 보존한다.
- terminal registry의 추가·삭제가 active terminal count에 즉시 반영된다.
- bundle이 교체되어도 active session이 있으면 handoff 결론은 `defer-handoff`다.
- preflight 이후 activity가 시작되면 teardown과 replacement spawn을 호출하지 않는다.
- 기존 activity가 없는 handoff와 automation pause/resume 동작은 유지된다.

## 비목표

- A+ Web scheduler의 idle 판정 구현 또는 정책 변경
- daemon handoff를 OS service manager 기반으로 재설계
- Happy CLI version bump, release tag, npm publish, A+ Dev Studio의 `vendor/happy`
  pointer 갱신
