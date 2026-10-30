# Plan

1. 테스트 먼저: 초기화 12초 통과, 60초 초과 차단, 초기화 중 중단, 단계·이유 진단 표, 훅 시간 로그(출력·토큰 미기록), 시간 초과 문구.
2. `credentialPin.ts`: `control(stage, call, timeoutMs)`로 단계별 제한과 거절 사유를 만들고, `refuse()`가 sanitize된
   `ClaudeAuthNotVerifiedError`를 던진다. 출력 스트림의 SessionStart `hook_started`/`hook_response`는 시각만 기록한다.
3. `launchFailureMessage.ts`: 오류 클래스(SDK 비의존 유지)와 시간 초과 문구.
4. `docs/cli-architecture.md` 동기화.

롤백: `INITIALIZE_TIMEOUT_MS`를 10초로 되돌리면 이전 동작. 진단 필드는 소비자가 없으면 무해하다.
Desktop은 새 문구 2개의 번역만 추가하면 된다(`src/domain/runtimeEventMessages.ts`).
