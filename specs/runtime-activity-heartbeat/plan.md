# plan

## Phase 1 — heartbeat 계약 고정 — Done

`DaemonStateSchema`에 optional activity payload와 non-negative integer count 계약을
추가하고, 암호화된 daemon state update에 값이 보존되는 회귀 테스트를 작성한다.

검증: `apiMachine.test.ts`의 encrypted daemon heartbeat 테스트.

## Phase 2 — runtime activity 집계 — Done

terminal registry가 현재 session 수를 제공하게 하고, daemon의 live child session,
terminal session, automation runner, server lease를 하나의 process-local provider에서
집계한다.

검증: `daemonTerminalSessions.test.ts`와 `apiMachine.test.ts`.

## Phase 3 — busy handoff 차단 — Done

bundle replacement 판단에 active session을 포함한다. preflight와 teardown 사이의
TOCTOU를 막기 위해 handoff helper가 teardown 직전에 activity를 다시 확인하게 한다.

검증: `daemonHandoffAutomationGate.test.ts`와 `handoff.test.ts`.

## Phase 4 — 독립 검토와 rollout — Done

변경 관련 unit test, typecheck, diff check와 PR CI를 확인한다. 구현 PR과 release
mutation을 분리하고, 별도 승인된 release workflow로만 배포한다.

검증: PR #293 CI, 독립 focused test 45개, PR #294 및
`happy-cli-v1.1.10-aplus.156` publish workflow.
