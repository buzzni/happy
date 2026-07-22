# 세션 생성자(createdBy) metadata 기록 Tasks

> plan.md의 각 Phase를 실행 단위로 분해한 체크리스트. 번호(T1, T2, ...)가 곧 실행 순서.
> 규칙: 승인 후에는 순서대로 **연속 실행** (한 번에 하나씩, 작업마다 재승인 없음).
> 각 작업 = 테스트 → 구현 → 전체 테스트 → 커밋 → 체크. Phase 경계와 중단 조건에서만 멈춤.

## 실행 순서 근거 (한 줄)

T1(타입/RPC 파라미터)이 전제 → T2(env 스레딩)가 T1에 의존 → T4(구조적 정리)를 T5(동작 변경)
전에 배치(Tidy First) → T6~T10(5개 러너)은 서로 독립이라 병렬 가능하지만 순서대로 진행 →
T11(데스크톱 배선)은 happy-cli 쪽이 먼저 끝나야 검증 가능해서 마지막.

## Phase 1: RPC 파라미터 → 환경변수 스레딩

- [x] T1. `SpawnSessionOptions`(`src/modules/common/registerCommonHandlers.ts:140`)에
      `createdByAccountId?: string`, `createdByDisplayName?: string` 추가 →
      검증: 타입 체크 통과 (커밋 be89583c)
- [x] T2. `apiMachine.ts:242-256`의 `spawn-happy-session` 핸들러 destructure에 두 필드 추가,
      `spawnSession()` 호출에 전달 → 검증: `apiMachine.spawnCreatedBy.test.ts` 2개 통과(있음/없음),
      typecheck 통과
- [ ] T3. `run.ts`의 `spawnSession`(라인 484-503 부근)에서 `options.createdByAccountId`/
      `createdByDisplayName`이 있으면 `extraEnv.HAPPY_CREATED_BY_ACCOUNT_ID`/
      `HAPPY_CREATED_BY_DISPLAY_NAME`을 채우는 조건 추가 → 검증: 없을 때 기존 env 키 목록과
      동일(회귀 없음), 있을 때 두 키가 추가됨을 단위 테스트로 확인
- [ ] T4. `sessionEnv.ts`의 `SESSION_LINEAGE_ENV_PREFIXES`에 `'HAPPY_CREATED_BY'` 추가 →
      검증: `scrubSessionLineageEnv`가 해당 키를 스크럽하는 테스트 추가/통과

## Phase 2: (structural) runClaude.ts → 공용 팩토리 통합

- [ ] T5. (structural) `runClaude.ts:142-163`의 inline `freshMetadata` 구성을
      `createSessionMetadata()`(공용 팩토리) 호출로 교체. `mergeReconnectSessionMetadata` 등
      나머지 로직은 그대로 유지 → 검증: 리팩토링 전후 `runClaude` 관련 기존 테스트 전부 통과,
      동작 변경 없음 확인 후 별도 커밋(behavioral 변경과 분리)

## Phase 3: (behavioral) createdBy 필드 추가 + 5개 러너 배선

- [ ] T6. `createSessionMetadata.ts`의 `CreateSessionMetadataOptions`에
      `createdBy?: { accountId: string; displayName?: string }` 추가, `metadata` 조건부
      스프레드(`...(opts.createdBy ? { createdBy: opts.createdBy } : {})`) → 검증:
      `createSessionMetadata.test.ts`에 "있음/없음" 두 케이스
- [ ] T7. `runClaude.ts`(T5로 팩토리 통합 완료 후) — `process.env.HAPPY_CREATED_BY_ACCOUNT_ID`/
      `HAPPY_CREATED_BY_DISPLAY_NAME`을 읽어 `createSessionMetadata()` 호출에 `createdBy` 전달 →
      검증: 스모크 테스트(env 있을 때 세션 metadata에 `createdBy` 포함)
- [ ] T8. `runCodex.ts`에 동일 배선 → 검증: 동일 패턴 스모크 테스트
- [ ] T9. `runGemini.ts`에 동일 배선 → 검증: 동일 패턴 스모크 테스트
- [ ] T10. `runOpenClaw.ts` + `agent/acp/runAcp.ts`에 동일 배선 → 검증: 두 러너 각각 스모크 테스트

## Phase 4: 데스크톱 쪽 배선 (cross-repo — aplus-dev-studio-desktop 저장소)

- [ ] T11. (cross-repo) 데스크톱 `SpawnHappySessionInput`/`SpawnSessionParams`
      (`src/sync/sessionCreation.ts`, `sessionCreationModel.ts`)에 `createdByAccountId`/
      `createdByDisplayName` optional 필드 추가, `createSessionForProject`가
      `extractAccountIdFromHappyJwt(auth.token) ?? auth.userId` / `auth.username`으로 채워
      RPC 호출에 포함 → 검증: `sessionCreation.test.ts`류에 신규 케이스
- [ ] T12. (cross-repo) 완료 시 `specs/desktop-conversation-search/tasks.md`의 T14를
      "차단 해제"로 갱신하고 그 쪽에서 파서(`apiSessionToSession`)·검색 스코프 연결 진행

## 승인 대기 중인 추가 작업 (스코프 확장 제안)

- [ ] (제안) happy-cli 릴리스(버전 bump·태그·`npm publish`) — 이 spec의 구현이 끝난 뒤,
      사용자의 명시적 승인을 별도로 받아야 진행(`AGENTS.md` "Happy CLI Release Publisher" 정책).
- [ ] (제안) 데스크톱의 happy-cli 버전 pin 갱신(`specs/happy-runtime-pin-aplus-6X` 패턴) —
      릴리스 완료 후 별도 작업으로 분리.
