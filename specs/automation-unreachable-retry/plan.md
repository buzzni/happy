# Plan

## 파일 배치 (수정 7 / 신규 3)
- 신규 `packages/happy-cli/src/daemon/automations/automationUnreachableRetry.ts` — 연결성 실패 분류와 보류 run 의
  저장·만료·재개 규칙을 실행기 밖에 둔다(H5가 같은 실행기를 고치므로 실행기 구조를 키우지 않기 위해).
- 신규 `automationUnreachableRetry.test.ts` — 실제 소켓 분류·간격 계산·사전 단계 표시 테스트.
- 신규 `specs/automation-unreachable-retry/` 문서 세트.
- 수정 `serverAutomationExecutor.ts`(보류·재개 훅), `serverAutomationRuntimeStore.ts`(저장 필드),
  `automationMcpCallerGrant.ts`·`automationProjectEnvironment.ts`(실패에 `unreachable` 표시), 대응 테스트 3개.

## 순서
1. [structural] 대기 보고 파서 함수 분리(보류 보고 파싱에 재사용).
2. [behavioral] 실행기 경계 테스트(빨강) → 저장 필드·모듈·훅 → 분류 테스트(빨강) → 표시 구현.
3. 셀프 리뷰 → 관련 vitest + tsc.

## 검증
`./node_modules/.bin/vitest run --project unit src/daemon/automations/`, `./node_modules/.bin/tsc --noEmit`.

## 되돌리기
행동 커밋 revert. 저장소에 남은 `unreachableRetries`는 구 파서가 무시한다.
