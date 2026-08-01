# 데몬 고아 세션 입양 Tasks

> plan.md의 각 Phase를 실행 단위로 분해한 체크리스트. 번호(T1, T2, ...)가 곧 실행 순서.
> 각 작업 = 테스트 → 구현 → 전체 테스트 → 커밋 → 체크. Phase 경계와 중단 조건에서만 멈춤.

## 실행 순서 근거 (한 줄)

T1(프로토콜 필드)이 T4(배선)의 전제 → T2(순수 입양 함수)·T3(가드 유예)은 서로 독립이지만 둘 다
T4보다 앞서야 배선이 green 상태로 끝남 → Phase 2는 Phase 1의 입양 함수를 재사용하므로 뒤 →
Phase 3/4는 독립 안전망이라 마지막.

## Phase 0: 확증

- [ ] T0. 사고 호스트에서 `grep -c "Ignoring runtime report for untracked session"
      ~/.happy/logs/*daemon.log` → 고아 sessionId가 나오면 D1 전제 확증.
      결과와 무관하게 Phase 1~4는 진행(둘 다 승인 범위). 결과는 context.md에 기록.

## Phase 1: 런타임 리포트 기반 입양 (R1~R5)

- [x] T1. `/session-runtime` 프로토콜에 `hostPid` additive 추가 —
      `controlClient.notifyDaemonSessionRuntime`이 `process.pid`를 실어 보내고,
      `controlServer`의 zod 스키마와 `onHappySessionRuntime` 시그니처가 이를 받는다.
      → 검증: `controlServer` 관련 테스트 + typecheck. 필드 없는 구버전 요청도 통과해야 함
- [x] T2. 새 모듈 `daemon/orphanAdoption.ts`에 순수 함수 `resolveOrphanAdoption()` 작성:
      `{sessionId, hostPid, persistedSessions, isPidAlive, now}` → `{session, startedAt} | null`.
      `startedBy` 복원(R2), 시작시각은 persisted 값(R3), `hostPid` 폴백 + 생존 검증(R5).
      → 검증: `orphanAdoption.test.ts` — daemon/터미널 startedBy 복원, hostPid 폴백,
      죽은 pid 미입양, persisted 기록 없음 미입양
- [x] T3. `evaluateIdleStopGuard`에 `adoptedAt?: number` + `IdleStopGuardConfig.adoptionGraceMs`
      추가 → 유예 내 `deny('adoption-grace')`. `readIdleStopGuardConfig`에
      `HAPPY_DAEMON_ADOPTION_GRACE_MS`(기본 120_000) 파싱 추가.
      → 검증: `sessionIdleReaper.test.ts` — 유예 내 거부 / 유예 후 통과 / `adoptedAt` 없으면
      기존과 동일 / force 경로 무영향
- [x] T4. `run.ts` 배선: `onHappySessionRuntime`의 untracked 분기에서 `resolveOrphanAdoption()`
      호출 → 성공 시 `pidToTrackedSession`/`sessionStartTimes`/`adoptedAt` 채우고
      `persistTrackedSessions()`, 실패 시 이유를 로그. `stopSession`의 가드 호출에 `adoptedAt` 전달.
      → 검증: typecheck + 전체 스위트, `daemon.integration.test.ts`에 "미추적 세션 리포트 →
      입양 → /list에 등장" 시나리오

## Phase 2: 기동 시 입양 (R6)

- [x] T5. `orphanAdoption.ts`에 `collectStartupOrphans()` 추가:
      `{persistedSessions, alreadyTracked, isPidAlive, getProcessStartedAt, now}` →
      입양 후보 배열. 시작시각 ≤ `savedAt` 검증, 시작시각 미확인 시 제외(R6).
      → 검증: `orphanAdoption.test.ts` — 정상 입양 / 이미 추적 중 제외 / pid 재사용(시작시각이
      savedAt 이후) 제외 / 시작시각 미확인 제외
- [x] T6. `run.ts` 복구 블록 직후 배선 + `getProcessStartedAt` 유틸(macOS/Linux `ps -o lstart=`,
      실패 시 `undefined`). 입양 건수 로그.
      → 검증: 유틸 단위 테스트(현재 프로세스 pid로 조회 시 값이 나오고 미래가 아님) + typecheck

## Phase 3: 버전 전환 창 봉인 (R7)

- [x] T7. `handoff.ts`에 순수 함수 `resolveStatePreservation({before, after})` 추가 —
      정지 전 스냅샷에 추적 세션이 있고 정지 후 상태가 사라졌으면 복원 대상 반환.
      `run.ts:175 stopRunningDaemon`에서 정지 전 `readDaemonState()` → 정지 → 필요 시
      `writeDaemonState({...before, state:'stopped'})`.
      → 검증: `handoff.test.ts` — 파일 유실 시 복원 / 보존됐으면 미복원 / 추적 세션 없으면 미복원

## Phase 4: 관측성 (R8)

- [x] T8. `run.ts` 복구 블록에서 `previousState`가 `null`일 때 경고 로그 추가
      ("이전 데몬의 세션이 있었다면 고아가 됐을 수 있음 — 리포트/기동 입양으로 회수 시도").
      → 검증: typecheck + 전체 스위트

## 중단 조건 (AGENTS.md §2.3)

- 가드 의미가 바뀌는 변경이 필요해지면 멈추고 보고 (리핑 정책은 spec 범위 밖)
- `daemon.integration.test.ts`가 입양 시나리오를 태우지 못하는 구조면 멈추고 대안 보고
