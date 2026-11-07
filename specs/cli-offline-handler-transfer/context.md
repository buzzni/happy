---
기능: cli-offline-handler-transfer
상태: 진행중(T6 — PR #1155 리뷰봇 반영·CI)
마지막 갱신: 2026-11-07
---

# context

## 현재 상태
origin/main 3fbd89815(.395)에서 분기. T1~T4 완료: stub 등록 기록·이전, swap 전 이전, 러너 4종 통합 테스트(각각 이전 줄을 주석 처리하면 실패함을 확인), Gemini 미뤄진 swap용 stub `queueInput`.
검증: `pnpm typecheck` 통과, 실제 unit 프로젝트(전역 build 포함)로 관련 9개 파일 151건 통과. 이후 추가분은 반복 설정으로 13건 통과.

## 결정 로그
- 2026-11-07 Claude 경로는 해당 없음(spec R4-c 근거). 오프라인 분기가 stub 없이 claudeLocal만 돌리고 종료.
- 2026-11-07 `onFileEvent`도 같은 결함이라 함께 이전(R4-a2). Codex가 stub에 등록.
- 2026-11-07 RPC `policy` 인자(`customerBound`)도 기억해 옮김 — 포크 `RpcHandlerManager.registerHandler`가 세 번째 인자를 받음(upstream엔 없음).
- 2026-11-07 ACP 러너도 같은 경로라 테스트 범위에 포함.
- 2026-11-07 Gemini는 처리 중이면 swap을 턴 끝까지 미룬다(`pendingSessionSwap`). 이전된 user-message 핸들러가 그 사이 `session.queueInput`을 stub에 불러 TypeError → 메시지 유실. 러너를 고치지 않고 stub에 실제와 같은 순수 `queueInput`을 둠(R4-b2). 계산은 `api/turnInputEvidence.ts`의 `queueInputEvidence`로 분리해 실제 세션과 공유(구조 커밋 분리).
- 2026-11-07 기록 비우기는 같은 객체를 제자리에서 비운다 — stub 클로저가 쥔 객체를 갈아 끼우면 이후 등록이 조용히 사라진다.
- 2026-11-07 Codex 오프라인 테스트는 run-once 없이 띄운다(오프라인 자동화는 Codex가 시작을 거부). 오프라인 Codex는 runtime gate가 없어 dispatch 핸들러를 설치하지 않으므로 그 describe에서 이전 테스트의 `fixture.markDispatched`를 비운다.

- 2026-11-07 교차 리뷰(codex gpt-6.1-sol, high) 3건:
  - 반영: Gemini 미뤄진 swap 중 kill이 stub에 기록 → `handleKillSession` 시작에서 `applyPendingSessionSwap()` (R4-b3).
  - 반영: R4-d 권한 핸들러 `updateSession` 단언 누락 → Codex·Gemini·ACP 러너 테스트에 `BasePermissionHandler.prototype.updateSession` 단언(삭제 시 실패 확인).
  - 미반영: Gemini 시작 중(MCP 조회 대기) 재접속하면 이전된 핸들러가 아직 초기화 안 된 `const updatePermissionMode`를 불러 ReferenceError. 같은 TDZ가 **온라인 시작에도** 그대로 있다(핸들러가 같은 줄에서 실제 세션에 등록됨). 오프라인 경로의 창은 서버 세션이 재접속 때 처음 생기므로 사용자가 그 세션을 보고 1초 안팎에 보내야 열린다. 러너 초기화 순서 문제라 swap 경로 밖 — 열린 문제로 남김.

- 2026-11-07 리뷰봇(cicd-buzzni, fa83c28, medium 1건) 반영: Codex 채널 수락기가 stub runtimeId(undefined)를 잡아, 이전된 capability가 알린 실제 runtimeId의 prompt를 거절 → deps에 `get runtimeId()` (R4-b4). 이전 전엔 unknown method로 깨끗이 거절되던 것을 "지원한다고 알리고 거절"로 바꾸지 않기 위함.

## 열린 문제
- (범위 밖) Codex 승인 경계 `installCodexApprovalBoundary`의 `runtimeId: session.runtimeId`도 오프라인 시작이면 undefined. 이전과 무관하게 origin/main에서 동일.
- (범위 밖) Gemini 첫 메시지 핸들러가 `updatePermissionMode`(runGemini.ts `const`, MCP 조회 await 뒤 선언)를 초기화 전에 부를 수 있음 — 온라인·오프라인 공통.
- (범위 밖) `api/apiSession.inputEvidenceLifecycle.test.ts` 두 건은 중첩 vitest가 90초 상한에 걸려 실패. head 쪽 `turnEventParity.scenarios.ts` 20건(T17/19·T18·T20/24, credentialPin Proxy `target.next`·15초 timeout)은 origin/main 소스로 돌려도 똑같이 20건 실패 — 이 변경과 무관.
- (범위 밖) stub에 `hasTitle`이 없어 오프라인에서 시작한 턴이 실패한다: Codex `runCodex.ts:2835`, Gemini `buildGeminiTurnPrompt({ hasTitle: session.hasTitle() })`. origin/main 동일. 재접속 뒤 턴은 실제 세션이라 정상.
- (범위 밖) `api/apiSession.test.ts` "reports an observed org deployment login only on the events it was handed"는 변경 전 코드에서도 실패(로컬, 전역 build 없는 반복 설정).

## 다음 시작점
PR https://github.com/buzzni/happy/pull/1155 — 리뷰봇 반영·CI 확인 뒤 머지는 지휘 세션.
