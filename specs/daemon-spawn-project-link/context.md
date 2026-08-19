---
기능: daemon-spawn-project-link
상태: 구현 완료(Phase 1·2) — 릴리스와 E2E는 선행 배포 대기
마지막 갱신: 2026-08-19
---

# 데몬 spawn 세션 프로젝트 연결 Context

## 현재 상태

Phase 1·2 구현 완료. 데몬은 이제 spawn 성공 직후 A+에 세션을 보고한다(fire-and-forget).
남은 것은 릴리스(T9)와 E2E(T10)이고 둘 다 선행 배포 대기다. **서버 양쪽은 이미 완성돼 있고 호출자만 없는 상태**라, 이 spec이
3개 저장소에 걸친 작업의 마지막 조각이다.

| 저장소 | 상태 |
|---|---|
| aplus-dev-studio-desktop | CLI 매칭·등록 (로그인한 사람 CLI 한정) — main 병합 완료 |
| buzzni/happy (server) | `POST /v1/machine-sessions/:sessionId/owner` — **PR #217, merge 대기** |
| aplus-dev-studio (server) | `POST /api/agent-spawn/session-link` — **PR #2203, merge 대기** |
| buzzni/happy (cli) | **이 spec** — 데몬 배선 |

## 핵심 결정 로그

- [2026-08-19] 배선 지점: `apiMachine.ts`의 `spawn-happy-session` 핸들러 `case 'success'`.
  이 지점에서 `result.sessionId`·`directory`·`machineId` 세 값이 **전부 이미 손에 있다**
  (directory는 핸들러 앞부분에서 `if (!directory) throw`로 이미 검증됨). 다른 곳에서 만들면
  세 값을 다시 끌어와야 한다.
- [2026-08-19] 선례 확인: `daemon/run.ts:1923`의 `linkSession`(automation)이 정확히 같은 일을
  하며 `credentials.token`(machine token)과 `process.env.HAPPY_APLUS_MCP_CONFIG_URL`을 쓴다.
  자격증명·URL 조달 방법은 새로 고민할 게 없다.
- [2026-08-19] 결정: `linkAutomationProjectSession`을 **확장하지 않고 형제 함수로 분리**.
  automation 경로는 `runId`/`claimToken`이 필수인데, 이를 optional로 만들면 실수로 claim 없이
  automation 링크를 호출할 수 있게 된다 — 느슨해지는 쪽이 automation 보안 경계다.
- [2026-08-19] 결정: 훅 반환 타입을 `void`로 둬서 **호출부가 await할 수 없게** 만든다.
  주석으로 "await하지 마시오"라고 쓰는 것보다 타입으로 막는 게 확실하다(R3).
- [2026-08-19] 확인(서버 코드 실측): 중복 등록은 안전하다.
  `ensureSessionToProject`는 `findFirst({sessionId, userId})`가 있으면 early-return하고,
  Desktop의 `assignSessionToProject`는 caller의 기존 매핑을 `deleteMany` 후 upsert한다.
  **어느 순서로 도착하든 Desktop의 명시적 프로젝트 선택이 이긴다.**
- [2026-08-19] 확인: 선행 배포 순서가 틀려도 안전하다. A+는 구버전 Happy의 404를
  "소유자 아님"이 아니라 unavailable(503)로 읽도록 설계됐고, 이 배선은 R2/R5에 따라 실패를
  삼키고 debug 로그만 남긴다. 최악의 경우가 "조용한 로그"다.

- [2026-08-19] 구현 중 정정: 처음엔 `apiMachine`에 "훅이 늦게 reject해도 spawn은 성공"
  테스트를 뒀는데, **훅 반환이 `void`라 apiMachine은 늦은 rejection을 구조적으로 잡을 수 없다** —
  그 테스트는 프로덕션이 아니라 자기 fake를 검증하고 있었고 unhandled rejection 경고만 만들었다.
  삭제하고, 방어를 실제 책임 지점인 배선 쪽 `linkSpawnedProjectSessionInBackground`로 옮겨
  거기서 테스트했다(성공=무음, 실패=debug 로그, 즉시 반환).
- [2026-08-19] 함정(worktree): happy-cli의 `node_modules`를 부모 저장소로 통째 심볼릭 링크하면
  `@slopus/happy-wire`가 **부모의 옛 소스**로 해석돼, 내 변경과 무관한 typecheck 오류가 난다.
  happy-cli만 엔트리별로 링크하고 `@slopus/happy-wire`는 worktree 자신의 것을 가리킨 뒤
  `packages/happy-wire`에서 `npm run build`(dist 생성)를 해야 오류 0건이 된다.
- [2026-08-19] 기준선 실측: happy-cli 전체 테스트는 원본 main에서도 **4 files / 20 tests가
  실패**한다(`daemon.integration`·`codex.integration`·`ripgrep`·`difftastic` — 실제 인증과
  바이너리가 필요한 환경 의존 테스트). 같은 커밋의 pristine worktree와 1:1로 대조해 동일함을
  확인했다. **"전체 통과"를 기대하지 말 것.** 추가로 `sessionScanner.test.ts`는 전체 부하에서
  가끔 떨어지는 flake다(단독 재실행하면 통과).

## 다음 세션 시작점

코드는 끝났다. 남은 것은 **배포 순서**뿐이고, 순서가 중요하다:

1. happy #217(서버 엔드포인트) merge
2. aplus-dev-studio #2203(A+ 라우트) merge
3. happy-cli 릴리스(T9) — AGENTS.md §1.8: 로컬 publish 금지, version bump → 태그 push → CI
4. `vendor/happy` 포인터 bump (aplus-dev-studio 별도 PR)
5. 실제 `saycode agent spawn` → A+ 프로젝트 목록 확인(T10) → 선행 spec 3개의 마지막 DoD도 함께 체크

**3번을 1번보다 먼저 하지 말 것** — 기능은 안 깨지지만 매 spawn마다 503 debug 로그만 쌓인다.
