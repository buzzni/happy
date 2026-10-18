# Plan

## 파일 배치 (수정 3 / 신규 5)
- 신규 `packages/happy-cli/src/claude/claudeTransientRetry.ts` — 결과 분류·턴 출력 관찰·대기/취소/예산 상태를
  런처 밖에 둔다. 런처는 이미 1,200줄이 넘고, 이 판단은 SDK 메시지만으로 단위 테스트할 수 있다.
- 신규 `claudeTransientRetry.test.ts` — 실측 메시지 모양 기반 분류, 간격·지터·힌트, 취소·경주(barrier).
- 신규 `claudeRemoteLauncher.transientRetry.test.ts` — 런처 경계: 대기 후 이어가기, 사용자 메시지·중단 취소,
  중복 전송 없음, 비용.
- 신규 `specs/claude-transient-retry/` 문서 세트.
- 수정 `claudeRemoteLauncher.ts`(관찰·onReady 예약·nextMessage 경주·abort 취소·종료 시 정리),
  `src/api/types.ts`(AgentState 에 `transientRetry` 추가), `src/claude/loop.ts` 없음.

## 순서
1. 분류·정책 모듈 실패 테스트 → 구현.
2. 런처 경계 실패 테스트 → 배선.
3. 셀프 리뷰 → 관련 vitest + tsc.

## 검증
`./node_modules/.bin/vitest run src/claude/claudeTransientRetry.test.ts src/claude/claudeRemoteLauncher*.test.ts`,
`./node_modules/.bin/tsc --noEmit` (packages/happy-cli).

## 되돌리기
행동 커밋 revert. agentState 의 `transientRetry` 는 소비자가 없어 남아도 무해하다.
