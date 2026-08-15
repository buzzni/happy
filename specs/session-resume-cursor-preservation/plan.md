# plan

## Phase 1 — 구조적 변경 (동작 변경 없음)

`PersistedSession → TrackedSession` 하이드레이션을 순수 함수로 추출한다.
`run.ts` 의 finished-session 맵 구성이 이미 하던 일을 그대로 옮기는 것이므로
동작은 바뀌지 않는다.

- NEW `packages/happy-cli/src/daemon/persistedSessionHydration.ts`
- NEW `packages/happy-cli/src/daemon/persistedSessionHydration.test.ts`
- `run.ts`: finished-session 맵이 새 함수를 쓰도록 교체
- `run.ts`: `readPersistedSessions()` 호출을 상태파일 복구 루프보다 위로 올려
  한 번만 읽고 재사용

검증: `pnpm vitest run src/daemon` 통과

## Phase 2 — 동작 변경 (AC1~AC4)

- `run.ts` 상태파일 복구 루프가 하이드레이션을 적용
- `orphanAdoption.ts` `resolveOrphanAdoption` 이 하이드레이션을 적용
- `run.ts` `preserveSessionForResume` 이 실패 이유를 로깅

검증: 실패 테스트 먼저 → 통과 확인

## Phase 3 — 모바일 앱 (AC5)

- `sources/sync/ops.ts`: resume 결과에 `code` 노출, `machineRecoverSession` 추가
- NEW `sources/sync/sessionRecovery.ts`: 복구 사다리 결정 로직 (deps 주입)
- NEW `sources/sync/sessionRecovery.test.ts`
- `sources/-session/SessionView.tsx`: 전송 경로가 사다리를 타도록 연결
- i18n 문자열 추가

검증: `pnpm vitest run sources/sync/sessionRecovery.test.ts`, `pnpm typecheck`

## 상태

- [x] Phase 1
- [x] Phase 2
- [x] Phase 3
