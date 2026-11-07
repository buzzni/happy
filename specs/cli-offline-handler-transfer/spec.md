# cli-offline-handler-transfer — 오프라인 시작 세션의 핸들러 이전

정본: Desktop `specs/happy-upstream-benchmark/spec.md` R4 (작업 H2, 2026-11-07 사용자 승인).
upstream 참고: slopus/happy #1858 (a72ebc4c7) `transferOfflineRegistrations`. 파일은 복사하지 않고 포크 stub 구조(EventEmitter·`TurnInputEvidence`)에 맞게 다시 씁니다.

## 문제

서버에 닿지 못한 채 시작하면 `setupOfflineReconnection`이 `createOfflineSessionStub`를 세션으로 돌려줍니다. 포크 stub는 `onUserMessage`·`onFileEvent`·`rpcHandlerManager.registerHandler`를 버립니다. 러너는 시작할 때 이 등록을 한 번만 하고, 재접속 뒤 `onSessionSwap`은 입력 큐·권한 핸들러·`archived` 리스너만 다시 붙입니다. 그래서 오프라인으로 시작한 세션은 재접속 뒤 앱 메시지·중단·종료·곁질문 등을 모두 무시합니다.

## 요구사항

- **R4** (정본 그대로) Given 서버 불가 상태로 시작해 stub 세션에 `onUserMessage`·RPC 핸들러를 등록한 러너, When 재접속으로 실제 세션으로 교체, Then 등록된 user-message 핸들러와 RPC 핸들러(abort·killSession·side-question 등)가 실제 세션에서 동작한다. Claude 경로도 같은 문제가 있으면 함께 고친다.

### 세부

- **R4-a** stub는 `onUserMessage` 핸들러와 `registerHandler(method, handler, policy?)` 등록을 기억한다. 같은 대상을 다시 등록하면 마지막 것이 이긴다(실제 `ApiSessionClient.onUserMessage`·`RpcHandlerManager.registerHandler`와 같은 의미). RPC의 세 번째 인자 `policy`(`customerBound`)도 함께 기억해 그대로 옮긴다.
- **R4-a2** 같은 결함인 `onFileEvent`(Codex가 stub에 등록) 핸들러도 같은 방식으로 기억하고 옮긴다. 실제 세션에서 `onFileEvent`도 마지막 등록이 이긴다.
- **R4-b** `setupOfflineReconnection`은 재접속으로 만든 실제 세션에 기록된 등록을 **`onSessionSwap` 호출 전에** 옮긴다(순서를 테스트로 고정). 옮긴 뒤 stub의 기록은 비운다. 실제 세션 생성 전에 실패한 재접속 시도는 기록을 건드리지 않아 다음 시도가 옮길 수 있다.
- **R4-b2** swap을 진행 중 턴이 끝날 때까지 미루는 러너(Gemini)는 이전 직후 실제 세션으로 들어온 메시지를 stub를 쥔 채 처리한다. 그 핸들러가 부르는 `session.queueInput(message)`이 stub에서도 실제 세션과 같은 큐 증거를 돌려줘 메시지를 잃지 않는다(공유 함수 `queueInputEvidence`).
- **R4-b3** Gemini가 swap을 미룬 사이 들어온 `killSession`(또는 archived)은 대기 중인 swap을 먼저 적용해, archive 기록·sessionDeath·close가 실제 세션에 남는다.
- **R4-b4** 이전된 Codex 채널 RPC는 재접속한 세션 기준으로 일관된다: `channel-capability`가 알리는 runtimeId로 온 `channel-prompt`를 수락한다(수락기가 runtimeId를 시작 시점 값이 아니라 매번 읽음).
- **R4-c** 러너 Codex·Gemini·OpenClaw에서 swap 뒤 user-message·abort·killSession이 실제 세션에서 동작함을 통합 수준 테스트(가짜 세션 객체)로 확인한다. 같은 stub 경로를 쓰는 ACP 러너(`agent/acp/runAcp.ts`)도 같은 테스트로 확인한다.
  - Claude 경로: **해당 없음**. `claude/runClaude.ts`의 오프라인 분기는 stub를 만들지 않고 `startOfflineReconnection`을 직접 써서 터미널 `claudeLocal`만 실행한 뒤 `process.exit(0)`으로 끝난다. 재접속으로 만든 세션은 로컬 전사를 올리는 스캐너용이며, 오프라인 동안 user-message·RPC 핸들러를 등록하는 대상이 없다(앱에서 받는 입력 경로 자체가 없음). `claudeRemote*.ts`는 온라인 세션에서만 쓰인다.
- **R4-d** 기존 swap 동작(`configureInputQueue`, `setInputSteerAvailable`, 권한 핸들러 `updateSession`, `archived` 리스너)은 그대로다 — 회귀 테스트.
- 회귀 금지: `resumeGuards`·`orphanAdoption`·`sessionIdleReaper`·`turnInactivityWatchdog` 등 포크 고유 보호 로직은 건드리지 않는다. 러너 파일 수정은 테스트 외에는 하지 않는다(swap 경로 한정 원칙, paseo T7과의 충돌 면적 최소화).

## 범위 밖

- Codex `installCodexApprovalBoundary({ runtimeId: session.runtimeId })`도 오프라인 시작이면 stub 값(undefined)을 잡는다. 이 변경 전부터 같고 이전과 무관해 남긴다(context 열린 문제).

- stub에 `hasTitle`이 없어 **오프라인 상태에서 시작한 턴**(Codex 첫 메시지, Gemini 초기 프롬프트)이 `TypeError: session.hasTitle is not a function`으로 실패한다(origin/main에서도 동일, 재접속 전 문제라 R4 밖). context 열린 문제에 기록.

- stub에 남는 그 밖의 no-op(`sendSessionEvent` 등 오프라인 중 보낸 메시지)의 재전송.
- swap 뒤 stub에 늦게 들어온 등록의 전달(러너는 모두 `session` 변수로 등록하므로 swap 뒤에는 실제 세션에 등록된다).
