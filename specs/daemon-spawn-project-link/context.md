---
기능: daemon-spawn-project-link
상태: 초안 — 승인 대기
마지막 갱신: 2026-08-19
---

# 데몬 spawn 세션 프로젝트 연결 Context

## 현재 상태

문서만 작성. 코드 없음. **서버 양쪽은 이미 완성돼 있고 호출자만 없는 상태**라, 이 spec이
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

## 다음 세션 시작점

spec.md 승인 → plan.md Phase 1(링크 함수)부터. 코드 작성 전 승인이 필수 게이트다.

**주의**: 실제 동작 확인(T10)은 happy #217과 aplus-dev-studio #2203이 merge·배포되고
`vendor/happy` 포인터가 올라간 뒤에만 가능하다. 그 전에 E2E가 안 된다고 이 배선을 의심하지 말 것.
