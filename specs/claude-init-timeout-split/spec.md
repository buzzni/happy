# Claude 시작 대기와 계정 확인 시간 제한 분리

> 상위 문서: Desktop `specs/claude-startup-timeout/` (요구사항 R1~R8, 결정 로그). 이 문서는 happy-cli 몫만 적는다.

## 문제

`src/claude/sdk/credentialPin.ts`는 모든 SDK 제어 호출에 10초 하나를 썼다. 첫 호출 `initializationResult()`는
SessionStart 훅이 끝나기를 기다리므로, 시작 훅이 10초를 넘는 프로젝트에서는 정상 토큰이어도
`CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED`("계정 또는 정책을 확인할 수 없음")로 요청이 막혔다.
실제 장애 두 건 모두 요청 시작 후 10.002초에 끝났다. 시간 초과와 실제 불일치가 같은 문구라 원인도 구분되지 않았다.

## 요구사항 (happy-cli 몫)

- 초기화 대기만 60초, 나머지 제어 호출(설정 조회·인증 플래그 적용·메시지별 재검증·곁질문 검사)은 10초.
- 초기화 60초 초과, 정책 충돌, 인증 환경·계정 불일치, 지원 안 되는 런타임은 계속 입력 없이 막는다. 사용자 중단은 중단으로 끝난다.
- 거절 오류는 메시지 원문(오류 코드)을 유지하고 고정 열거값 `stage`(initialize/settings/apply/recheck)와
  `reason`(timeout/unsupported/mismatch/policy/control_failed)만 붙인다. 상위 오류 원문·토큰은 붙이지 않는다.
- 시간 초과는 별도 사용자 문구(`CLAUDE_STARTUP_TIMEOUT_NOTICE`, `CLAUDE_AUTH_CHECK_TIMEOUT_NOTICE`). 나머지는 기존 문구.
- 데몬 로그: 제어 호출별 소요 시간, 거절 단계·이유·경과 시간, SessionStart 훅 시작/종료 시각. 훅 출력·토큰은 남기지 않는다.

## 비목표

- 훅 실행 시간을 빼고 세는 SDK `startup()` 방식 — 60초로 부족하다는 로그 증거가 나오면 재검토.
- 오류 코드 문자열 변경, 릴리스·Desktop pin.

## 검증

- `npx vitest run src/claude/sdk/credentialPin.test.ts src/claude/utils/launchFailureMessage.test.ts` (globalSetup이 `tsc` 포함 빌드)
- 실제 SDK: `HAPPY_CLAUDE_AUTH_PIN_INTEGRATION=1 npx vitest run --project integration-claude-auth-pin src/claude/sdk/credentialPin.integration.test.ts` — 12초 SessionStart 훅에서 개인·조직 모두 약 12.3초에 완료, 초기화 제한을 10초로 되돌리면 두 건 실패(2026-10-30 확인). 로컬 더미 서버·토큰만 쓴다.
