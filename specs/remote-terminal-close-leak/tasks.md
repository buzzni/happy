# 원격 터미널 종료 시 PTY 프로세스 누수 수정 Tasks

> 작성일: 2026-07-30
> 근거 문서: [spec.md](./spec.md) / [plan.md](./plan.md)

## Phase 1 — `PtySession.terminate()` / `isAlive()`

- [x] T1. `src/daemon/remoteTerminal.test.ts` 신규 — 실제 `/bin/bash -l` PTY 픽스처로
      `kill('SIGTERM')` 후 `isAlive() === true` (SIGTERM 무시 사실 고정, R7a). win32 skip
- [x] T2. 같은 파일 — `terminate({graceMs: 300})` 후 `isAlive() === false` (R1, R7b)
- [x] T3. 같은 파일 — SIGHUP을 트랩해 무시하는 셸에도 SIGKILL 승급으로 회수됨 (R2)
- [x] T4. 같은 파일 — 이미 종료된 세션에 `terminate()`를 호출해도 reject하지 않고 즉시
      resolve (R8, 멱등성)
- [x] T5. `src/daemon/remoteTerminal.ts` — `isAlive()`, `terminate()` 구현 +
      `kill()` 기본 신호 `SIGTERM` → `SIGHUP` (R1~R3)
- [x] T6. `pnpm -C packages/happy-cli vitest run --project unit src/daemon/remoteTerminal.test.ts`
      통과 + `typecheck`

## Phase 2 — 종료 경로 전환

- [x] T7. `src/daemon/daemonTerminalSessions.test.ts` — bash 픽스처로
      `killAllDaemonTerminalSessions()`가 대화형 셸을 실제로 회수 (R5)
- [x] T8. `src/daemon/daemonTerminalSessions.test.ts` — idle 워치독이 대화형 셸을 실제로
      회수 (R6). 기존 `node -e` 픽스처 테스트는 그대로 유지(R8 회귀 감시)
- [x] T9. `src/daemon/daemonTerminalSessions.ts` — `killAllDaemonTerminalSessions()`
      `signal` 파라미터 제거 + `terminate()` 사용, idle 워치독도 `terminate()` (R5, R6)
- [x] T10. `src/api/apiMachine.ts` — `terminal-close-fwd`가 `terminate()` 사용 (R4),
      disconnect 경로 호출 시그니처 정정
- [x] T11. 기존 `killAll` 테스트(`'SIGTERM'` 인자 전달)를 새 시그니처로 갱신 —
      버그를 인코딩한 단정이므로 교체가 정당
- [x] T12. `pnpm -C packages/happy-cli test`(유닛 전체) + `typecheck` 통과

## Phase 3 — 문서

- [x] T13. `context.md` 작성 — 재현 로그, 기각한 대안, 수동 회수 명령, 테스트 픽스처
      교훈
- [ ] T14. 커밋 분리 확인 — Phase 1 / Phase 2 / Phase 3 각각 별도 커밋(모두 동작 변경 +
      문서, 구조적 변경 없음)

## 이월 / 별도 안건 (이번 스코프 밖)

- 주기적 고아 리퍼: 판정 기준을 나이가 아니라 명시적 close 상태로 두는 별도 spec 필요
- 데몬 재시작 시 이전 세대 PTY 회수(상태 파일에 pid 기록)
- `startServer.ts` 등 다른 셸 스폰 지점의 종료 신호 감사
