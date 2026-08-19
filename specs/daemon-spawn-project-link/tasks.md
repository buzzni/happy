# 데몬 spawn 세션 프로젝트 연결 Tasks

> plan.md의 각 Phase를 실행 단위로 분해한 체크리스트.

## Phase 1: 링크 함수

- [ ] T1. (Red) `automationMcpCallerGrant.spec.ts`(또는 형제 spec)에 `linkSpawnedProjectSession`
  실패 테스트를 쓴다 → 검증: configUrl 없음→`{ok:true,skipped:true}`, 200→`{ok:true}`,
  403/503→`{ok:false,error}`, abort→`{ok:false,error}`. **어떤 케이스도 throw하지 않는다**
- [ ] T2. (Green) `linkAutomationProjectSession` 옆에 구현. 본문은
  `{machineId, sessionId, directory}`, 경로는 `/api/agent-spawn/session-link`,
  타임아웃은 기존 `EXCHANGE_TIMEOUT_MS` 재사용

## Phase 2: spawn 훅과 DI 배선

- [ ] T3. (Red) `MachineRpcHandlers.linkSpawnedSession` 훅이 spawn 성공 시
  `{sessionId, directory}`로 불리는 테스트 추가 (`apiMachine.spawnCreatedBy.test.ts` 패턴)
- [ ] T4. (Green) `MachineRpcHandlers`에 선택 필드 추가 + `setRPCHandlers`에서 보관 +
  `case 'success'`에서 호출. **반환 타입은 `void`** (await 불가능하게 해 R3을 타입으로 강제)
- [ ] T5. (Red→Green) 훅이 throw해도 spawn 응답이 `{type:'success'}`인 테스트 → 호출부
  `try/catch` + `.catch()` 추가 (R2)
- [ ] T6. 훅 미주입(undefined)이어도 정상 동작 / `error`·`requestToApproveDirectoryCreation`
  분기에서는 호출되지 않음을 테스트 (R6)
- [ ] T7. `run.ts`에서 `configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL`,
  `machineToken: credentials.token`, `machineId`로 주입 — 기존 `linkSession` 배선 옆

## Phase 3: 회귀와 E2E

- [ ] T8. `tsc --noEmit` 오류 0건, happy-cli 테스트 전체 통과
- [ ] T9. 릴리스: AGENTS.md §1.8대로 **로컬 publish 금지** — version bump → 태그 push → CI가
  유일한 publisher
- [ ] T10. 선행 배포(happy #217, aplus-dev-studio #2203) 확인 후 실제 `saycode agent spawn` →
  A+ 프로젝트 대화 목록에 세션이 뜨는지 확인 → 선행 spec들의 마지막 DoD 항목도 함께 체크

## 승인 대기 중인 추가 작업 (스코프 확장 제안)

- [ ] (제안) `vendor/happy` 포인터 bump — aplus-dev-studio 쪽 별도 PR
