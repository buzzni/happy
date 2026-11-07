# plan — cli-offline-handler-transfer

## 아키텍처 영향

- Core/Extension 분류: Core(happy-cli 세션 수명주기·재접속). 공개 API·스키마·와이어 변경 없음.
- 바뀌는 모듈: `utils/offlineSessionStub.ts`(등록 기록 + `transferOfflineRegistrations` 추가), `utils/setupOfflineReconnection.ts`(swap 전에 이전 호출 한 줄).
- 러너 소스(`codex/runCodex.ts`·`gemini/runGemini.ts`·`openclaw/runOpenClaw.ts`·`agent/acp/runAcp.ts`)는 바꾸지 않는다. 이전은 공통 경로에서 한 번만 한다 — 러너마다 swap 콜백에 넣으면 같은 수정이 네 번 복제되고 새 러너가 빠뜨린다.

## 설계

- 기록은 모듈 수준 `WeakMap<stub, OfflineRegistrations>`에 둔다(upstream과 같은 계약). stub 객체에 공개 필드를 늘리지 않아 `ApiSessionClient` 타입 캐스팅 범위가 그대로다.
- `OfflineRegistrations = { userMessageHandler, fileEventHandler, rpcHandlers: Map<method, { handler, policy }> }`.
- `transferOfflineRegistrations(stub, session)`: RPC → file-event → user-message 순으로 등록하고 기록을 비운다. user-message를 마지막에 두는 이유: 실제 세션의 `onUserMessage`는 대기 중 메시지를 즉시 흘려보내므로, 그 처리 중 RPC가 필요하면 이미 등록돼 있어야 한다.
- stub가 아닌 객체(기록 없음)를 받으면 아무것도 하지 않는다.

## 대안

- 러너별 `onSessionSwap`에서 다시 등록: 네 러너에 핸들러 정의를 끌어올려야 해 변경 면적이 크고 paseo T7과 충돌. 기각.
- stub가 swap 뒤 실제 세션으로 위임(프록시): 요구사항(R4-b: 옮긴 뒤 비움)보다 넓고 수명이 복잡해짐. 기각.

## 검증

- `utils/offlineSessionStub.test.ts`: 기록·재등록·policy 보존·이전 후 비움·비 stub 무시.
- `utils/setupOfflineReconnection.test.ts`(신규): 오프라인 → 재접속 → 이전이 swap 전 → 실제 세션에서 수신, 실패 시도 뒤 재시도도 이전.
- 러너 테스트: `openclaw/runOpenClaw.test.ts`·`agent/acp/runAcp.test.ts` 확장, Codex·Gemini는 swap 경로용 테스트 파일.
- `pnpm typecheck`, 관련 vitest, `pnpm build`, happy CI.

## 복구

- 되돌리기: 두 소스 파일 변경을 revert하면 이전 동작(등록 버림)으로 돌아간다. 데이터 영향 없음.
