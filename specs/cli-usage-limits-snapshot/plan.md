# plan — cli-usage-limits-snapshot

## 아키텍처 영향

- Core/Extension 분류: Core(happy-cli Claude 실행 루프와 세션 agentState 게시). 와이어는 `AgentState`에 선택 필드 하나 추가(정본 R8이 승인한 범위) — 서버·happy-wire 변경 없음, 구 클라이언트는 무시.
- 바뀌는 모듈:
  - 신규 `claude/utils/usageLimits.ts` — 정규화·병합 순수 함수(R8-a). 단위 테스트가 쉬워야 해서 분리.
  - 신규 `claude/utils/usageLimitsCollector.ts` — query 하나 동안의 버퍼·seed·직렬화·변화 판정(R8-b). `claudeRemote.ts`(1300줄)에 상태를 더 얹지 않고, `claudeRemote` 전체 하네스 없이 시나리오를 시험하기 위해 분리.
  - `claude/claudeRemote.ts` — 수집기 생성, `rate_limit_event` 관측, result에서 비우기 예약, 옵션 `onUsageLimits`.
  - `claude/claudeRemoteLauncher.ts` — `onUsageLimits`를 `updateAgentState` 병합으로 연결.
  - `api/types.ts` — `UsageLimits`·`UsageLimitWindow` 타입과 `AgentState.usageLimits?`.

## 설계

- 수집기 위치는 upstream처럼 query 수명(= `claudeRemote` 한 번). 계정 전환·모드 전환·체크포인트 턴은 provider를 다시 띄우므로 새 query의 첫 result에서 다시 seed(`replace`)해 이전 계정 창이 남지 않는다.
- 병합은 launcher의 `updateAgentState` 콜백 안 — 버전 충돌 재시도가 최신 상태 위에서 다시 병합한다. `mergeUsageLimits`는 멱등.
- result 처리는 비우기를 기다리지 않는다(fire-and-forget, 직렬 체인). seed 실패·시간 초과는 이벤트만 게시.
- `rate_limit_event`는 지금처럼 `onMessage`로도 넘겨 계정 전환 소비자가 그대로 받는다(R8-c).
- upstream과 다른 점: 창 `resetsAt`은 ISO(정본 R8 "unix초→ISO"; upstream은 epoch ms). 같은 내용 재게시(upstream 5분 갱신)는 하지 않는다(정본 R8 "변화 없으면 생략").

## 대안

- launcher `onMessage`에서 수집: 이벤트는 이미 거기 오지만 query 수명(seed 시점·`get_usage` 함수)은 `claudeRemote`만 안다. 곁질문 채널을 빌려 `get_usage`를 부르면 곁질문 수명·관리 실행 차단에 묶인다. 기각.
- `setupTokenUsageTracker`를 확장해 공유: tracker는 계정 전환 규칙(5h/7d만, 소진 임계)에 맞춘 상태 기계라 모든 창을 다루는 스냅샷과 목적이 다르다. 공유하면 서로의 변경이 다른 쪽을 흔든다(R8-c). 기각.

## 검증

- `claude/utils/usageLimits.test.ts`: 비율→%·unix초→ISO·ms 입력, get_usage 0~100·ISO·`extra_usage` 제외, `synthesizeStatus` 경계(89.9/90/99.9/100/비숫자), id 병합·빈 비율 유지·`replace`·unbound(최고 사용률 창, `plan` upsert)·깨진 current·멱등·입력 불변.
- `claude/utils/usageLimitsCollector.test.ts`: 턴당 1회, 첫 result만 seed(`skipBehaviors: true`), 이벤트 우선+비율 보충, 변화 없으면 생략, seed 실패·불가·시간 초과, 직렬화.
- `claude/claudeRemote.test.ts`: 두 턴 query에서 result마다 최대 1회 `onUsageLimits`, 첫 result seed, 변화 없으면 생략, `rate_limit_event`가 `onMessage`로도 감(R8-c), 구 상태와 병합.
- 회귀: `setupTokenUsageTracker`·`setupTokenAccountSwitching`·`claudeRemoteLauncher.setupTokenSwitch`·`claudeSideQuestion` 테스트.
- `pnpm typecheck`, 관련 vitest, `pnpm build`, happy CI.

## 복구

- revert하면 `usageLimits` 게시가 사라진다. 이미 쓰인 `agentState.usageLimits`는 읽는 쪽이 없어(D6 전) 무해하고, 다음 상태 쓰기에서 그대로 남을 뿐이다. 데이터 손실 없음.
